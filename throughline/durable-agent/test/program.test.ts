import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";
import { ENGINE, encode, type Hello, lineSplitter, PROTOCOL_VERSION } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/faux-program.ts", import.meta.url));
const toolsFixture = fileURLToPath(new URL("./fixtures/faux-tools-program.ts", import.meta.url));
const bashFixture = fileURLToPath(new URL("./fixtures/faux-bash-program.ts", import.meta.url));
const roots: string[] = [];
const started: AgentProgram[] = [];
after(async () => {
	// A failed assertion leaves its program running; stop it so the runner can exit.
	for (const program of started) program.kill();
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await mkdtemp(join(tmpdir(), "durable-agent-test-"));
	roots.push(root);
	return { store: join(root, "store"), cwd: root };
}
type Stored = { id: number; kind: string; conversationId: number; model?: { role: string; content: unknown }[] };
/** Every entry the bound conversation shows, through the program's own `entries` call (what ThroughLine reads). */
async function storedEntries(program: AgentProgram): Promise<Stored[]> {
	const all: Stored[] = [];
	let cursor: unknown;
	do {
		const page = (await program.call("entries", { limit: 100, ...(cursor === undefined ? {} : { cursor }) })) as { items: Stored[]; next?: unknown };
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined && cursor !== null);
	return all;
}
const userText = (entry: Stored) => {
	const content = entry.model?.[0]?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
};
const startBash = (store: string, cwd: string) => {
	const program = startProgram(process.execPath, [bashFixture, store, cwd]);
	started.push(program);
	return program;
};
async function turn(program: AgentProgram, content: string, requestId: string): Promise<void> {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	const settled = (await program.call("wait", { submissionId })) as { status: string };
	assert.equal(settled.status, "done", program.stderr());
}
const start = (store: string, cwd: string, protocol?: number) => {
	const program = startProgram(process.execPath, [fixture, store, cwd], protocol === undefined ? {} : { protocol });
	started.push(program);
	return program;
};

test("hello carries the protocol, engine, version, store, agent and pid; a call answers", async () => {
	const { store, cwd } = await fresh();
	const program = start(store, cwd);
	const hello = await program.hello;
	assert.equal(hello.protocol, PROTOCOL_VERSION);
	assert.equal(hello.engine, ENGINE);
	assert.match(hello.version, /^\d+\.\d+\.\d+/);
	assert.equal(hello.store, store);
	assert.equal(hello.agent, "test-agent");
	assert.equal(hello.pid, program.child.pid);
	const { submissionId } = (await program.call("submit", { content: "go", requestId: "r1" })) as {
		submissionId: number;
	};
	const settled = (await program.call("wait", { submissionId })) as { status: string };
	assert.equal(settled.status, "done");
	const again = (await program.call("submit", { content: "go", requestId: "r1" })) as { submissionId: number };
	assert.equal(again.submissionId, submissionId, "the same requestId returns the same submission");
	await program.call("drain");
	assert.equal(await program.exited, 0);
	assert.equal(await readFile(join(cwd, "effect.txt"), "utf8"), "line\n");
});

test("a client with another protocol version is refused", async () => {
	const { store, cwd } = await fresh();
	const program = start(store, cwd, PROTOCOL_VERSION + 1);
	await program.hello;
	assert.equal(await program.exited, 4);
});

test("a second program on the same store is refused while the first runs", async () => {
	const { store, cwd } = await fresh();
	const first = start(store, cwd);
	await first.hello;
	const second = start(store, cwd);
	await assert.rejects(second.hello, /STORE_ALREADY_OWNED/);
	assert.equal(await second.exited, 3);
	await first.call("drain");
	await first.exited;
});

test("after a kill the next program takes the store", async () => {
	const { store, cwd } = await fresh();
	const first = start(store, cwd);
	await first.hello;
	const { submissionId } = (await first.call("submit", { content: "one", requestId: "a" })) as {
		submissionId: number;
	};
	await first.call("wait", { submissionId });
	first.kill();
	await first.exited;
	const second = start(store, cwd);
	await second.hello;
	const next = (await second.call("submit", { content: "two", requestId: "b" })) as { submissionId: number };
	await second.call("wait", { submissionId: next.submissionId });
	const ids = (await storedEntries(second)).map((entry) => entry.id);
	assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "each entry once, in id order");
	assert.equal(ids.length >= 8, true);
	await second.call("drain");
	await second.exited;
});

test("a ThroughLine tool call leaves on the link with the stock tool name and its answer reaches the model", async () => {
	const { store, cwd } = await fresh();
	const program = startProgram(process.execPath, [toolsFixture, store, cwd]);
	const calls: { id: string; name: string; arguments: unknown }[] = [];
	program.onToolCall((call) => {
		calls.push(call);
		program.answerTool(call.id, { content: [{ type: "text", text: "task-1 is completed" }] });
	});
	await program.hello;
	const { submissionId } = (await program.call("submit", { content: "check", requestId: "t1" })) as {
		submissionId: number;
	};
	const settled = (await program.call("wait", { submissionId })) as { status: string };
	assert.equal(settled.status, "done");
	assert.deepEqual(
		calls.map((call) => [call.name, call.arguments]),
		[["task_status", { taskId: "task-1" }]],
	);
	assert.match(JSON.stringify(await storedEntries(program)), /task-1 is completed/, "the tool result is recorded in the conversation");
	await program.call("drain");
	await program.exited;
});

/** A reader of the program's read socket, found through the store's owner.lock (as show-me finds it). */
async function openOwner(store: string): Promise<{ hello: Hello; call(method: string, params?: Record<string, unknown>): Promise<unknown>; page(): Promise<Stored[]>; close(): void }> {
	const owner = JSON.parse(await readFile(join(store, "owner.lock"), "utf8")) as { socket?: string };
	assert.ok(owner.socket, "the owner record names the read socket");
	const socket = connect(owner.socket);
	const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let greeted: (hello: Hello) => void = () => undefined;
	const hello = new Promise<Hello>((resolve) => (greeted = resolve));
	socket.setEncoding("utf8");
	socket.on(
		"data",
		lineSplitter((line) => {
			const message = JSON.parse(line) as { kind: string; id?: string; value?: unknown; message?: string; code?: string };
			if (message.kind === "hello") return greeted(message as unknown as Hello);
			const pending = message.id === undefined ? undefined : waiting.get(message.id);
			if (pending === undefined) return;
			waiting.delete(message.id as string);
			if (message.kind === "result") pending.resolve(message.value);
			else pending.reject(new Error(`${message.code}: ${message.message}`));
		}),
	);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	socket.write(encode({ kind: "hello", protocol: PROTOCOL_VERSION, engine: ENGINE, version: "test", pid: process.pid }));
	let serial = 0;
	const call = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<unknown>((resolve, reject) => {
			const id = `r${++serial}`;
			waiting.set(id, { resolve, reject });
			socket.write(`${JSON.stringify({ kind: "call", id, method, params })}\n`);
		});
	const page = async () => {
		const all: Stored[] = [];
		let cursor: unknown;
		do {
			const result = (await call("entries", { limit: 2, ...(cursor === undefined ? {} : { cursor }) })) as { items: Stored[]; next?: unknown };
			all.push(...result.items);
			cursor = result.next;
		} while (cursor !== undefined && cursor !== null);
		return all;
	};
	return { hello: await hello, call, page, close: () => socket.destroy() };
}

// Design brief 5, note B (build round 12): the agent answers its own `entries` method on a read socket whose path is
// in owner.lock. A connection pins the conversation bound at its hello, so it never mixes branches and never shows a
// withdrawn turn that was not live at that moment.
test("the read socket named in owner.lock serves the live branch with the link's entries; a rewind shows to new readers, a pinned reader keeps its branch whole", async () => {
	const { store, cwd } = await fresh();
	const program = startBash(store, cwd);
	await program.hello;
	await turn(program, "Retained choice.", "a");
	await turn(program, "Withdrawn choice.", "b");
	const before = await openOwner(store);
	assert.equal(before.hello.store, store);
	assert.deepEqual((await before.page()).map((entry) => entry.id), (await storedEntries(program)).map((entry) => entry.id), "the socket's entries equal the link's");
	const withdrawn = (await storedEntries(program)).find((entry) => userText(entry) === "Withdrawn choice.");
	assert.ok(withdrawn);
	await program.call("forkBefore", { entryId: withdrawn.id });
	await turn(program, "Replacement choice.", "c");
	const after = await openOwner(store);
	const live = await after.page();
	assert.deepEqual(live.map((entry) => entry.id), (await storedEntries(program)).map((entry) => entry.id));
	assert.deepEqual(live.filter((entry) => entry.kind === "pi.user").map(userText), ["Retained choice.", "Replacement choice."]);
	assert.equal(after.hello.conversationId, Number(((await program.call("status")) as { conversationId: number }).conversationId), "hello pins the bound conversation");
	const pinned = await before.page();
	assert.ok(pinned.some((entry) => userText(entry) === "Withdrawn choice.") && !pinned.some((entry) => userText(entry) === "Replacement choice."), "a reader pinned before the rewind keeps the earlier branch whole, nothing of the new one");
	await assert.rejects(after.call("submit", { content: "x", requestId: "z" }), /READ_ONLY_LINK/);
	before.close();
	after.close();
	assert.deepEqual((await readdir(store)).filter((name) => !["owner.lock", "store.sqlite", "store.sqlite-wal", "store.sqlite-shm"].includes(name)), [], "a read writes nothing in the store folder");
	await program.call("drain");
	await program.exited;
});

// The real path: a command the model runs (as a show-me skill body tells it to) reads the socket its own owner names.
test("a command the agent runs reads its own live branch through the socket named in owner.lock", async () => {
	const { store, cwd } = await fresh();
	await writeFile(join(cwd, "read-owner.mjs"), READ_OWNER_SCRIPT);
	const program = startBash(store, cwd);
	await program.hello;
	await turn(program, "Keep this decision.", "a");
	await turn(program, `bash: node read-owner.mjs ${store}`, "b");
	const result = JSON.stringify(await storedEntries(program));
	assert.match(result, /owner read: .*?Keep this decision\./, "the command saw the live turn through the socket");
	await program.call("drain");
	await program.exited;
});

// A crash leaves a record whose socket nobody answers; the next start writes a record whose socket answers; a clean
// stop removes both the socket and the record.
test("after a kill the stale record's socket does not answer; a restart's does; a clean stop removes the socket", async () => {
	const { store, cwd } = await fresh();
	const first = startBash(store, cwd);
	await first.hello;
	await turn(first, "Before the kill.", "a");
	const stale = (JSON.parse(await readFile(join(store, "owner.lock"), "utf8")) as { socket: string }).socket;
	first.kill();
	await first.exited;
	await assert.rejects(new Promise((resolve, reject) => connect(stale).once("connect", resolve).once("error", reject)), /ECONNREFUSED|ENOENT/);
	const second = startBash(store, cwd);
	await second.hello;
	const reader = await openOwner(store);
	assert.notEqual(JSON.parse(await readFile(join(store, "owner.lock"), "utf8")).socket, stale);
	assert.ok((await reader.page()).some((entry) => userText(entry) === "Before the kill."));
	reader.close();
	const current = (JSON.parse(await readFile(join(store, "owner.lock"), "utf8")) as { socket: string }).socket;
	await second.call("drain");
	await second.exited;
	assert.ok(!existsSync(current), "the socket is removed at stop");
	assert.ok(!existsSync(join(store, "owner.lock")), "and the record with it");
});

// Rereview10/11: the new program never reads, writes, moves or removes an older agent's transcript.jsonl.
test("an upgraded store's transcript.jsonl is left untouched by the new program", async () => {
	const { store, cwd } = await fresh();
	await mkdir(store, { recursive: true });
	const legacyBytes = `${JSON.stringify({ seq: 1, conversation: { id: 1 } })}\n`;
	await writeFile(join(store, "transcript.jsonl"), legacyBytes);
	const program = startBash(store, cwd);
	await program.hello;
	await turn(program, "New decision after upgrade.", "u1");
	assert.equal(await readFile(join(store, "transcript.jsonl"), "utf8"), legacyBytes, "the old file is byte-unchanged");
	await program.call("drain");
	await program.exited;
});

/** A minimal reader of the owner socket, run by the scripted model as a skill body would run show-me. */
const READ_OWNER_SCRIPT = `import { readFileSync } from "node:fs";
import { connect } from "node:net";
const store = process.argv[2];
const socket = connect(JSON.parse(readFileSync(store + "/owner.lock", "utf8")).socket);
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () => {
	socket.write(JSON.stringify({ kind: "hello", protocol: 2, engine: "pi-durable", version: "probe", pid: process.pid }) + "\\n");
	socket.write(JSON.stringify({ kind: "call", id: "1", method: "entries", params: { limit: 500 } }) + "\\n");
});
socket.on("data", (chunk) => {
	buffer += chunk;
	for (const line of buffer.split("\\n").slice(0, -1)) {
		const message = JSON.parse(line);
		if (message.kind !== "result") continue;
		const texts = message.value.items.filter((e) => e.kind === "pi.user").map((e) => JSON.stringify(e.model[0].content));
		console.log("owner read: " + texts.join(" | "));
		socket.destroy();
	}
	buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
});
`;
