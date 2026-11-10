// The read socket's connection rules (build rounds 13 and 14; Rereview12-1 #3, 12-2 #2/#3, 12-3 #2, 13-1 #3, 13-2 #3,
// 13-3 #3/#4): one request per connection, byte limits on request and whole reply counted before parsing or sending,
// absolute deadlines, a clean close on disconnect, a read fixed to one conversation and last entry, and every page read
// inside the step that rebinds the thread, so a reply is the old live branch or the new one, never a withdrawn one.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { READ_LIMITS, type ReadLimits, serveOwnerReads } from "../src/owner-read.ts";

type Entry = { id: number; text: string };
/** A conversation that shows `entries` (ascending ids), with Durable's id bounds and limit; `gate` holds a read open. */
function conversation(id: number, entries: Entry[], gate?: Promise<void>): Conversation {
	return {
		id,
		entries: async (query: { order?: string; minEntryId?: number; maxEntryId?: number }, limit: number) => {
			if (gate !== undefined && query.order !== "descending") await gate;
			const shown = entries.filter((entry) => entry.id >= (query.minEntryId ?? 0) && entry.id <= (query.maxEntryId ?? Infinity));
			if (query.order === "descending") shown.reverse();
			return { items: shown.slice(0, limit), ...(shown.length > limit ? { next: "more" } : {}) };
		},
	} as unknown as Conversation;
}
const servers: { close(): Promise<void> }[] = [];
after(async () => {
	for (const server of servers) await server.close();
});
/** The program's serialized step (program.ts), around a bound conversation the test can rebind. */
function thread(first: Conversation) {
	let bound = first;
	let step: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const run = step.then(work, work);
		step = run.catch(() => undefined);
		return run;
	};
	return {
		withBound: <T>(read: (b: Conversation) => Promise<T>) => serialized(() => read(bound)),
		rebind: (next: Conversation) =>
			serialized(async () => {
				bound = next;
			}),
	};
}
async function serve(first: Conversation, limits: Partial<ReadLimits> = {}) {
	const owner = thread(first);
	const reads = await serveOwnerReads("/store", owner.withBound, BACKGROUND_CONTEXT, { ...READ_LIMITS, ...limits });
	servers.push(reads);
	return { socket: reads.socket, rebind: owner.rebind };
}
type Line = { kind: string; code?: string; value?: { items: Entry[]; more: boolean; lastEntryId: number; conversationId: number } };
/** Send `parts` (each after `gapMs`) on one connection and collect everything until the socket closes. */
function exchange(socket: string, parts: string | string[], gapMs = 0): Promise<{ lines: Line[]; raw: string; ms: number }> {
	const began = Date.now();
	const pieces = typeof parts === "string" ? [parts] : parts;
	return new Promise((resolve, reject) => {
		const client = connect(socket);
		let data = "";
		client.setEncoding("utf8");
		client.on("connect", () => {
			pieces.forEach((piece, index) => setTimeout(() => !client.destroyed && client.write(piece), index * gapMs));
		});
		client.on("data", (chunk: string) => (data += chunk));
		client.on("error", (error: NodeJS.ErrnoException) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? undefined : reject(error)));
		client.on("close", () => resolve({ lines: data.split("\n").filter(Boolean).map((line) => JSON.parse(line)), raw: data, ms: Date.now() - began }));
	});
}
const call = (params: Record<string, unknown> = {}, id = "1", padding = "") => `${JSON.stringify({ kind: "call", id, method: "entries", params, padding })}\n`;

test("one request per connection: a second request on the same connection gets no answer, and the socket closes", async () => {
	const { socket } = await serve(conversation(1, [{ id: 1, text: "a" }]));
	const { lines } = await exchange(socket, call({}, "1") + call({}, "2"));
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0]?.value?.items.map((entry) => entry.text), ["a"]);
});

test("a request over the byte limit is refused before parsing: no newline, a complete line in one write, and multibyte text", async () => {
	const { socket } = await serve(conversation(1, [{ id: 1, text: "a" }]), { requestBytes: 1024 });
	assert.equal((await exchange(socket, "x".repeat(4096))).lines[0]?.code, "REQUEST_TOO_LARGE");
	assert.equal((await exchange(socket, call({}, "1", "x".repeat(4096)))).lines[0]?.code, "REQUEST_TOO_LARGE", "a complete over-limit line");
	// 400 characters, 1,200 bytes: counted in bytes.
	assert.equal((await exchange(socket, call({}, "1", "€".repeat(400)))).lines[0]?.code, "REQUEST_TOO_LARGE", "multibyte text counted in bytes");
	assert.equal((await exchange(socket, call({}, "1", "x".repeat(900)))).lines[0]?.kind, "result", "a request under the limit is answered");
});

test("the request deadline is absolute: a reader trickling bytes is disconnected on time", async () => {
	const { socket } = await serve(conversation(1, []), { requestTimeoutMs: 200 });
	const silent = await exchange(socket, "");
	assert.ok(silent.ms >= 150 && silent.ms < 3000, `silent closed after ${silent.ms} ms`);
	const trickle = await exchange(socket, Array.from({ length: 20 }, () => " "), 50);
	assert.equal(trickle.lines.length, 0);
	assert.ok(trickle.ms < 600, `trickling reader closed after ${trickle.ms} ms`);
});

test("the whole encoded reply stays within the reply limit, envelope and id included; one entry over the limit is refused", async () => {
	const entries = [1, 2, 3, 4, 5].map((id) => ({ id, text: "y".repeat(300) }));
	const { socket } = await serve(conversation(7, entries), { replyBytes: 1000 });
	const first = await exchange(socket, call({}, "i".repeat(100)));
	assert.ok(Buffer.byteLength(first.raw) <= 1000, `reply was ${Buffer.byteLength(first.raw)} bytes`);
	const page = first.lines[0]?.value;
	assert.ok(page && page.items.length >= 1 && page.more);
	const next = (await exchange(socket, call({ conversationId: 7, lastEntryId: 5, after: page.items.at(-1)?.id }))).lines[0]?.value;
	assert.equal(next?.items[0]?.id, (page.items.at(-1)?.id ?? 0) + 1);
	const tooLarge = await serve(conversation(7, [{ id: 1, text: "z".repeat(2000) }]), { replyBytes: 1000 });
	assert.equal((await exchange(tooLarge.socket, call())).lines[0]?.code, "ENTRY_TOO_LARGE");
});

test("a read is fixed to the last entry at its first page; a page for a conversation no longer bound is refused", async () => {
	const entries: Entry[] = [
		{ id: 1, text: "a" },
		{ id: 2, text: "b" },
	];
	const { socket, rebind } = await serve(conversation(1, entries), { pageEntries: 1 });
	const first = (await exchange(socket, call())).lines[0]?.value;
	assert.deepEqual([first?.lastEntryId, first?.more], [2, true]);
	entries.push({ id: 3, text: "appended while reading" });
	const second = (await exchange(socket, call({ conversationId: 1, lastEntryId: 2, after: 1 }))).lines[0]?.value;
	assert.deepEqual([second?.items.map((entry) => entry.id), second?.more], [[2], false], "an entry appended after the first page is not part of this read");
	await rebind(conversation(2, [{ id: 1, text: "a" }]));
	assert.equal((await exchange(socket, call({ conversationId: 1, lastEntryId: 2, after: 1 }))).lines[0]?.code, "REWOUND");
});

// Rereview13-3 #3: the round-13 socket took the bound conversation once and read it while a rewind landed, answering
// with the withdrawn branch after the new one was bound. Now a rebind waits for the read in progress, so that read is
// the branch that was live for its whole step, and every later read sees the new branch.
test("a rewind during a one-page read waits for it: the reply is the branch live for the whole read, the next read is the new branch", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const { socket, rebind } = await serve(conversation(1, [{ id: 1, text: "live before the rewind" }], gate));
	const reading = exchange(socket, call());
	await new Promise((resolve) => setTimeout(resolve, 50));
	let rebound = false;
	const rewinding = rebind(conversation(2, [{ id: 1, text: "live after the rewind" }])).then(() => (rebound = true));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(rebound, false, "the rebind waits for the read in progress");
	release();
	const reply = (await reading).lines[0]?.value;
	await rewinding;
	assert.deepEqual([reply?.conversationId, reply?.items.map((entry) => entry.text)], [1, ["live before the rewind"]]);
	const afterRewind = (await exchange(socket, call())).lines[0]?.value;
	assert.deepEqual([afterRewind?.conversationId, afterRewind?.items.map((entry) => entry.text)], [2, ["live after the rewind"]]);
});

test("anything but one entries call is refused; a reader that disconnects mid-request leaves the socket answering", async () => {
	const { socket } = await serve(conversation(1, [{ id: 1, text: "a" }]));
	assert.equal((await exchange(socket, `${JSON.stringify({ kind: "call", id: "1", method: "submit", params: {} })}\n`)).lines[0]?.code, "BAD_REQUEST");
	assert.equal((await exchange(socket, "not json\n")).lines[0]?.code, "BAD_REQUEST");
	assert.equal((await exchange(socket, call({}, "i".repeat(200)))).lines[0]?.code, "BAD_REQUEST", "an id over 128 characters");
	await new Promise<void>((resolve) => {
		const client = connect(socket, () => {
			client.write('{"kind":"call"');
			client.destroy();
			resolve();
		});
	});
	assert.deepEqual((await exchange(socket, call())).lines[0]?.value?.items.map((entry) => entry.text), ["a"]);
});

test("the socket lives in a private folder that close removes", async () => {
	const reads = await serveOwnerReads("/store", thread(conversation(1, [])).withBound, BACKGROUND_CONTEXT);
	assert.ok(existsSync(reads.socket));
	await reads.close();
	assert.ok(!existsSync(reads.socket));
});
