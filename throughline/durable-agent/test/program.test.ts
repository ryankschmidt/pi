import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("after a kill the next program takes the store; transcript.jsonl holds each entry once, in order", async () => {
	const { store, cwd } = await fresh();
	const first = start(store, cwd);
	await first.hello;
	const { submissionId } = (await first.call("submit", { content: "one", requestId: "a" })) as {
		submissionId: number;
	};
	await first.call("wait", { submissionId });
	first.kill();
	await first.exited;
	// A kill mid-write leaves a torn last line; the next start cuts it off and writes that record again.
	await appendFile(join(store, "transcript.jsonl"), '{"seq":99,"entry":{"id":');
	const second = start(store, cwd);
	await second.hello;
	const next = (await second.call("submit", { content: "two", requestId: "b" })) as { submissionId: number };
	await second.call("wait", { submissionId: next.submissionId });
	await second.call("drain");
	await second.exited;
	const lines = (await readFile(join(store, "transcript.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	const ids = lines.filter((l) => "entry" in l).map((l) => Number(l.entry.id));
	assert.ok(lines.every((l) => "entry" in l || "conversation" in l || "binding" in l), "every line parses as a record");
	assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "each entry once, in id order");
	assert.equal(lines.filter((l) => "conversation" in l).length, 1);
	assert.equal(ids.length >= 8, true);
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
	await program.call("drain");
	await program.exited;
	const transcript = await readFile(join(store, "transcript.jsonl"), "utf8");
	assert.match(transcript, /task-1 is completed/, "the tool result is recorded in the conversation");
});

type Line = { entry?: { id: number; kind: string }; conversation?: { id: number }; binding?: { conversationId: number } };
const transcriptLines = async (store: string): Promise<Line[]> =>
	(await readFile(join(store, "transcript.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Line);
const lastBinding = (lines: Line[]) => lines.filter((l) => l.binding).at(-1)?.binding?.conversationId;

test("the transcript names the live conversation: a binding line at start, on fork, on forkBefore and at every restart", async () => {
	const { store, cwd } = await fresh();
	const first = start(store, cwd);
	const hello = await first.hello;
	assert.equal(lastBinding(await transcriptLines(store)), hello.conversationId, "the new root is bound at start");
	const { submissionId } = (await first.call("submit", { content: "one", requestId: "a" })) as { submissionId: number };
	await first.call("wait", { submissionId });
	const answer = (await transcriptLines(store)).filter((l) => l.entry?.kind === "pi.assistant").at(-1)?.entry?.id;
	const fork = (await first.call("fork", { entryId: answer })) as { conversationId: number };
	assert.equal(lastBinding(await transcriptLines(store)), fork.conversationId, "a fork is bound");
	const before = (await first.call("forkBefore", { entryId: answer })) as { conversationId: number };
	assert.equal(lastBinding(await transcriptLines(store)), before.conversationId, "a rewind is bound");
	await first.call("drain");
	await first.exited;

	// A crash after a fork's creation and before its binding: the store holds a newer conversation that is not bound.
	const storage = await openNodeSqliteStorage(join(store, "store.sqlite"));
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(storage, { models: createModels(), registry, env: () => { throw new Error("no runs here"); } } as never, BACKGROUND_CONTEXT);
	const bound = await harness.conversation(before.conversationId as ConversationId, BACKGROUND_CONTEXT);
	const unbound = await harness.conversation(fork.conversationId as ConversationId, BACKGROUND_CONTEXT);
	const orphan = await unbound?.fork(answer as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	await harness.close(BACKGROUND_CONTEXT);
	assert.ok(bound && orphan && Number(orphan.id) > before.conversationId, "the unbound fork is the newest conversation");

	const second = start(store, cwd);
	await second.hello;
	const lines = await transcriptLines(store);
	assert.ok(lines.some((l) => l.conversation?.id === Number(orphan?.id)), "the catch-up records the unbound fork");
	assert.equal(lastBinding(lines), before.conversationId, "the restart names the stored binding, not the newest conversation");
	await second.call("drain");
	await second.exited;
});

test("the transcript is rebuilt from the store at start: a lost newline, a cut tail or a moved line never drops or reorders a stored entry", async () => {
	const { store, cwd } = await fresh();
	const first = start(store, cwd);
	await first.hello;
	for (const [index, content] of ["one", "two"].entries()) {
		const { submissionId } = (await first.call("submit", { content, requestId: `n${index}` })) as { submissionId: number };
		await first.call("wait", { submissionId });
	}
	await first.call("drain");
	await first.exited;
	const file = join(store, "transcript.jsonl");
	const entryIds = (text: string) =>
		text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Line).flatMap((line) => (line.entry ? [line.entry.id] : []));
	const clean = await readFile(file, "utf8");
	const stored = entryIds(clean);
	const lines = clean.trimEnd().split("\n");
	const userLine = lines.find((line) => (JSON.parse(line) as Line).entry?.kind === "pi.user") as string;
	// The three byte states the reviewers built (Rereview3-1, 3-2, 3-3), each followed by a restart on the same store.
	const damage: [string, string][] = [
		["a complete last record whose newline was not written", clean.trimEnd()],
		["the file cut right after a complete user entry, no newline", `${lines.slice(0, lines.indexOf(userLine) + 1).join("\n")}`],
		["a user entry moved to the end without its newline", `${lines.filter((line) => line !== userLine).join("\n")}\n${userLine}`],
	];
	for (const [label, bytes] of damage) {
		await writeFile(file, bytes);
		const again = start(store, cwd);
		await again.hello;
		await again.call("drain");
		await again.exited;
		const text = await readFile(file, "utf8");
		assert.ok(text.endsWith("\n"), label);
		assert.deepEqual(entryIds(text), stored, `${label}: every stored entry once, in commit order`);
		assert.ok(text.split("\n").filter((line) => line.trim()).every((line) => JSON.parse(line)), label);
	}
});
