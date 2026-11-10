import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";
import { ENGINE, PROTOCOL_VERSION } from "../src/protocol.ts";

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

type Reply = { kind: string; code?: string; message?: string; value?: { store: string; conversationId: number; lastEntryId: number; items: Stored[]; more: boolean } };
type OwnerRecord = { pid: number; reads?: { state: string; socket?: string; reason?: string } };
const ownerRecord = async (store: string) => JSON.parse(await readFile(join(store, "owner.lock"), "utf8")) as OwnerRecord;
/** One request on one connection to the socket the store's owner record names (as show-me asks it). */
async function ask(store: string, params: Record<string, unknown> = {}): Promise<Reply> {
	const socket = (await ownerRecord(store)).reads?.socket;
	assert.ok(socket, "the owner record names a ready read socket");
	return await new Promise<Reply>((resolve, reject) => {
		const client = connect(socket);
		let data = "";
		client.setEncoding("utf8");
		client.on("connect", () => client.write(`${JSON.stringify({ kind: "call", id: "1", method: "entries", params })}\n`));
		client.on("data", (chunk: string) => (data += chunk));
		client.on("error", reject);
		client.on("close", () => resolve(JSON.parse(data.split("\n")[0] ?? "null") as Reply));
	});
}
/** The whole live branch, page by page, fixed to the first page's conversation and last entry. */
async function readOwner(store: string): Promise<Stored[]> {
	const first = await ask(store);
	assert.equal(first.kind, "result", JSON.stringify(first));
	const items = [...(first.value?.items ?? [])];
	let more = first.value?.more;
	while (more) {
		const page = await ask(store, { conversationId: first.value?.conversationId, lastEntryId: first.value?.lastEntryId, after: items.at(-1)?.id });
		assert.equal(page.kind, "result", JSON.stringify(page));
		items.push(...(page.value?.items ?? []));
		more = page.value?.more;
	}
	return items;
}
const STORE_FILES = ["owner.lock", "owner-reads.v1", "store.sqlite", "store.sqlite-wal", "store.sqlite-shm"];

// Design brief 5, note B (build rounds 12 and 13): the agent answers reads on a socket its owner record names; each
// connection carries one request; a read is fixed to the bound conversation and its last entry at the first page.
test("the read socket serves the live branch the link shows; after a rewind a read shows the new branch; a read continued across the rewind is refused", async () => {
	const { store, cwd } = await fresh();
	const program = startBash(store, cwd);
	await program.hello;
	await turn(program, "Retained choice.", "a");
	await turn(program, "Withdrawn choice.", "b");
	const first = await ask(store);
	assert.equal(first.value?.store, store);
	assert.deepEqual((await readOwner(store)).map((entry) => entry.id), (await storedEntries(program)).map((entry) => entry.id), "the socket's entries equal the link's");
	const withdrawn = (await storedEntries(program)).find((entry) => userText(entry) === "Withdrawn choice.");
	assert.ok(withdrawn);
	await program.call("forkBefore", { entryId: withdrawn.id });
	await turn(program, "Replacement choice.", "c");
	const live = await readOwner(store);
	assert.deepEqual(live.map((entry) => entry.id), (await storedEntries(program)).map((entry) => entry.id));
	assert.deepEqual(live.filter((entry) => entry.kind === "pi.user").map(userText), ["Retained choice.", "Replacement choice."]);
	const continued = await ask(store, { conversationId: first.value?.conversationId, lastEntryId: first.value?.lastEntryId, after: 0 });
	assert.equal(continued.code, "REWOUND", "a read begun before the rewind cannot finish with the withdrawn branch");
	assert.deepEqual((await readdir(store)).filter((name) => !STORE_FILES.includes(name)), [], "a read writes nothing in the store folder");
	await program.call("drain");
	await program.exited;
});

// The real path: a command the model runs (as a show-me skill body tells it to) reads the socket its own owner names.
test("a command the agent runs reads its own live branch through the socket its owner record names", async () => {
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

// Item 1 (Rereview12-1 #1, 12-2 #1, 12-3 #1): the first start marks the store for good, so a stopped store is never
// mistaken for an older agent's; the marker survives a clean stop and a kill; a crash leaves a record whose socket
// nobody answers; a clean stop removes the socket and the record.
test("the first start marks the store for good; after a kill the stale socket does not answer; a restart's does; a clean stop removes socket and record, never the marker", async () => {
	const { store, cwd } = await fresh();
	const first = startBash(store, cwd);
	await first.hello;
	assert.ok(existsSync(join(store, "owner-reads.v1")), "the first start writes the marker");
	await turn(first, "Before the kill.", "a");
	const stale = (await ownerRecord(store)).reads?.socket;
	assert.ok(stale);
	first.kill();
	await first.exited;
	await assert.rejects(new Promise((resolve, reject) => connect(stale).once("connect", resolve).once("error", reject)), /ECONNREFUSED|ENOENT/);
	assert.ok(existsSync(join(store, "owner-reads.v1")), "the marker survives a kill");
	const second = startBash(store, cwd);
	await second.hello;
	assert.notEqual((await ownerRecord(store)).reads?.socket, stale);
	assert.ok((await readOwner(store)).some((entry) => userText(entry) === "Before the kill."));
	const current = (await ownerRecord(store)).reads?.socket;
	await second.call("drain");
	await second.exited;
	assert.ok(current !== undefined && !existsSync(current), "the socket is removed at stop");
	assert.ok(!existsSync(join(store, "owner.lock")), "and the record with it");
	assert.ok(existsSync(join(store, "owner-reads.v1")), "the marker survives a clean stop");
});

test("a start refused by a live owner leaves the store unmarked", async () => {
	const { store, cwd } = await fresh();
	await mkdir(store, { recursive: true });
	// An older agent's record: a live process (this test runner), no reads field.
	await writeFile(join(store, "owner.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: "older" }));
	const program = startBash(store, cwd);
	await assert.rejects(program.hello, /STORE_ALREADY_OWNED/);
	await program.exited;
	assert.ok(!existsSync(join(store, "owner-reads.v1")), "an older agent's running store is not marked");
});

// Rereview13-2 #2, 14-1 #1, 14-3 #2: the marker was written before later start-up steps that can fail, so a failed
// upgrade made an old thread unreadable; and a dangling link at the marker's name counted for the writer but not for
// show-me. The marker now comes only after the agent fully started with its socket serving.
test("a start that fails before or after its read socket is serving leaves the store unmarked and its old file unchanged; a link at the marker's name is replaced by a file", async () => {
	const { store, cwd } = await fresh();
	await mkdir(store, { recursive: true });
	await writeFile(join(store, "store.sqlite"), "not a database");
	const failing = startBash(store, cwd);
	await assert.rejects(failing.hello, /PROGRAM_FAILED/);
	await failing.exited;
	assert.ok(!existsSync(join(store, "owner-reads.v1")), "a start failing before the socket leaves the store unmarked");
	const late = (await fresh()).store;
	await mkdir(late, { recursive: true });
	const legacyBytes = `${JSON.stringify({ seq: 1, conversation: { id: 1 } })}\n`;
	await writeFile(join(late, "transcript.jsonl"), legacyBytes);
	const afterSocket = startProgram(process.execPath, [bashFixture, late, cwd, join(cwd, "no-such-session.jsonl")]);
	started.push(afterSocket);
	await assert.rejects(afterSocket.hello, /PROGRAM_FAILED: .*ENOENT/);
	await afterSocket.exited;
	assert.match(afterSocket.stderr(), /no-such-session\.jsonl/, "it failed carrying, after the socket was serving");
	assert.ok(!existsSync(join(late, "owner-reads.v1")), "a start failing after the socket leaves the store unmarked");
	assert.ok(!existsSync(join(late, "owner.lock")), "and releases its record");
	assert.equal(await readFile(join(late, "transcript.jsonl"), "utf8"), legacyBytes, "the old file is unchanged");
	const linked = (await fresh()).store;
	await mkdir(linked, { recursive: true });
	await symlink(join(linked, "nowhere"), join(linked, "owner-reads.v1"));
	const program = startBash(linked, cwd);
	await program.hello;
	assert.ok((await lstat(join(linked, "owner-reads.v1"))).isFile(), "the marker is a regular file");
	await program.call("drain");
	await program.exited;
});

// Item 2 (Rereview12-1 #2): the read socket is an add-on; when it cannot be created the agent starts and works, the
// owner record says reads are unavailable and why (show-me refuses with that reason), and the failure is logged.
test("when the read socket cannot be created the agent still starts and works; the owner record and the log say why", async () => {
	const { store, cwd } = await fresh();
	const program = startProgram(process.execPath, [bashFixture, store, cwd], { env: { ...process.env, TMPDIR: join(cwd, "no-such-folder") } });
	started.push(program);
	await program.hello;
	await turn(program, "Works without the socket.", "a");
	const record = await ownerRecord(store);
	assert.equal(record.reads?.state, "unavailable");
	assert.match(record.reads?.reason ?? "", /read socket could not be created: .*ENOENT/);
	assert.match(program.stderr(), /show-me cannot read this thread from the agent: the read socket could not be created/);
	assert.ok((await storedEntries(program)).some((entry) => userText(entry) === "Works without the socket."));
	await program.call("drain");
	await program.exited;
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
const socket = connect(JSON.parse(readFileSync(store + "/owner.lock", "utf8")).reads.socket);
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(JSON.stringify({ kind: "call", id: "1", method: "entries", params: {} }) + "\\n"));
socket.on("data", (chunk) => (buffer += chunk));
socket.on("close", () => {
	const message = JSON.parse(buffer.split("\\n")[0]);
	const texts = message.value.items.filter((e) => e.kind === "pi.user").map((e) => JSON.stringify(e.model[0].content));
	console.log("owner read: " + texts.join(" | "));
});
`;
