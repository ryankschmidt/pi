import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type EntryId, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";
import { ENGINE, PROTOCOL_VERSION } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/faux-program.ts", import.meta.url));
const toolsFixture = fileURLToPath(new URL("./fixtures/faux-tools-program.ts", import.meta.url));
const snapshotFixture = fileURLToPath(new URL("./fixtures/faux-snapshot-program.ts", import.meta.url));
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
const startSnapshot = (store: string, cwd: string, pageSize?: number) => {
	const program = startProgram(process.execPath, [snapshotFixture, store, cwd, ...(pageSize === undefined ? [] : [String(pageSize)])]);
	started.push(program);
	return program;
};
async function turn(program: AgentProgram, content: string, requestId: string): Promise<void> {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	const settled = (await program.call("wait", { submissionId })) as { status: string };
	assert.equal(settled.status, "done", program.stderr());
}
/** The path the newest conversation_snapshot call returned, read from its stored tool result. */
const snapshotPath = (entries: Stored[]) => {
	const found = [...JSON.stringify(entries).matchAll(/(\/[^"\\]*\/snapshots\/\d+-\d+\.jsonl)/g)].at(-1)?.[1];
	assert.ok(found, "a conversation_snapshot result names a file");
	return found;
};
const snapshotEntries = async (path: string): Promise<Stored[]> =>
	(await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => (JSON.parse(line) as { entry: Stored }).entry);

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

test("conversation_snapshot after a restart writes the live branch only: a rewound turn and a newer unbound fork never appear", async () => {
	const { store, cwd } = await fresh();
	const first = startSnapshot(store, cwd);
	await first.hello;
	await turn(first, "Retained root.", "a");
	await turn(first, "Withdrawn branch choice.", "b");
	const withdrawn = (await storedEntries(first)).find((entry) => userText(entry) === "Withdrawn branch choice.");
	const withdrawnAnswer = (await storedEntries(first)).at(-1);
	assert.ok(withdrawn && withdrawnAnswer);
	await first.call("forkBefore", { entryId: withdrawn.id });
	await turn(first, "Current choice.", "c");
	await first.call("drain");
	await first.exited;

	// The reviewers' crash shape: a newer fork of the withdrawn branch, created and never bound.
	const storage = await openNodeSqliteStorage(join(store, "store.sqlite"));
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(storage, { models: createModels(), registry, env: () => { throw new Error("no runs here"); } } as never, BACKGROUND_CONTEXT);
	const root = await harness.conversation(withdrawn.conversationId as ConversationId, BACKGROUND_CONTEXT);
	const orphan = await root?.fork(withdrawnAnswer.id as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	await harness.close(BACKGROUND_CONTEXT);
	assert.ok(orphan, "the unbound fork exists");

	const second = startSnapshot(store, cwd);
	await second.hello;
	await turn(second, "snapshot please", "d");
	const entries = await storedEntries(second);
	const path = snapshotPath(entries);
	const written = await snapshotEntries(path);
	const last = Math.max(...written.map((entry) => entry.id));
	assert.deepEqual(written.map((entry) => entry.id), entries.map((entry) => entry.id).filter((id) => id <= last), "the file holds what the bound conversation shows, in order");
	assert.deepEqual(written.filter((entry) => entry.kind === "pi.user").map(userText), ["Retained root.", "Current choice.", "snapshot please"]);
	assert.ok(!JSON.stringify(written).includes("Withdrawn branch choice."), "the withdrawn turn is never in the file");
	assert.ok(!(await readdir(store)).includes("transcript.jsonl"), "no transcript file is written");

	await turn(second, "snapshot again", "e");
	const again = snapshotPath(await storedEntries(second));
	assert.notEqual(again, path);
	assert.deepEqual(await readdir(join(store, "snapshots")), [again.split("/").at(-1)], "the earlier snapshot is removed");
	await second.call("drain");
	await second.exited;
});

test("a program killed while conversation_snapshot writes leaves no partial file at a final name; the next call writes a whole one", { timeout: 120_000 }, async () => {
	const { store, cwd } = await fresh();
	const first = startSnapshot(store, cwd, 1);
	await first.hello;
	for (let index = 0; index < 60; index++) await turn(first, `Turn ${index}.`, `h${index}`);
	await first.call("submit", { content: "snapshot now", requestId: "s1" });
	// Page size 1 makes the write take one store read per entry; kill as soon as the temporary file exists.
	const folder = join(store, "snapshots");
	const deadline = Date.now() + 30_000;
	let caught = false;
	while (!caught && Date.now() < deadline) {
		try {
			caught = readdirSync(folder).some((name) => name.startsWith(".tmp-"));
		} catch {}
	}
	first.kill();
	await first.exited;
	assert.ok(caught, "the kill landed while the snapshot was being written");
	for (const name of await readdir(folder)) {
		if (name.startsWith(".tmp-")) continue;
		await snapshotEntries(join(folder, name)); // parses whole: a final name is only ever a renamed, complete file
	}

	const second = startSnapshot(store, cwd, 1);
	await second.hello;
	await turn(second, "snapshot after the kill", "s2");
	const entries = await storedEntries(second);
	const path = snapshotPath(entries);
	const written = await snapshotEntries(path);
	const last = Math.max(...written.map((entry) => entry.id));
	assert.deepEqual(written.map((entry) => entry.id), entries.map((entry) => entry.id).filter((id) => id <= last));
	assert.deepEqual(await readdir(folder), [path.split("/").at(-1)], "the killed write's temporary file is gone");
	await second.call("drain");
	await second.exited;
});

test("snapshots are private under umask 022: the file 0600, its folder 0700 even when it existed wider", async () => {
	const { store, cwd } = await fresh();
	await mkdir(join(store, "snapshots"), { recursive: true, mode: 0o755 });
	const previous = process.umask(0o022);
	try {
		const program = startSnapshot(store, cwd);
		await program.hello;
		await turn(program, "snapshot", "u1");
		const path = snapshotPath(await storedEntries(program));
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(store, "snapshots"))).mode & 0o777, 0o700);
		await program.call("drain");
		await program.exited;
	} finally {
		process.umask(previous);
	}
});
