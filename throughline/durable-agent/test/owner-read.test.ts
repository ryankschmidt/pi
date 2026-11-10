// The read socket's connection rules (build round 13, Rereview12-1 #3, 12-2 #2/#3, 12-3 #2): one request per
// connection, size limits on request and reply, deadlines on both ends, a clean close on disconnect, a read fixed to one
// conversation and last entry, and a rewind between pages refused.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { READ_LIMITS, type ReadLimits, serveOwnerReads } from "../src/owner-read.ts";

type Entry = { id: number; text: string };
/** A conversation that shows `entries` (ascending ids), with Durable's id bounds and limit. */
function conversation(id: number, entries: Entry[]): Conversation {
	return {
		id,
		entries: async (query: { order?: string; minEntryId?: number; maxEntryId?: number }, limit: number) => {
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
async function serve(current: () => Conversation, limits: Partial<ReadLimits> = {}) {
	const reads = await serveOwnerReads("/store", current, BACKGROUND_CONTEXT, { ...READ_LIMITS, ...limits });
	servers.push(reads);
	return reads;
}
/** Send `text` on one connection and collect everything the socket sends until it closes. */
function exchange(socket: string, text: string): Promise<{ lines: { kind: string; code?: string; value?: { items: Entry[]; more: boolean; lastEntryId: number; conversationId: number } }[]; ms: number }> {
	const began = Date.now();
	return new Promise((resolve, reject) => {
		const client = connect(socket);
		let data = "";
		client.setEncoding("utf8");
		client.on("connect", () => client.write(text));
		client.on("data", (chunk: string) => (data += chunk));
		client.on("error", reject);
		client.on("close", () => resolve({ lines: data.split("\n").filter(Boolean).map((line) => JSON.parse(line)), ms: Date.now() - began }));
	});
}
const call = (params: Record<string, unknown> = {}, id = "1") => `${JSON.stringify({ kind: "call", id, method: "entries", params })}\n`;

test("one request per connection: a second request on the same connection gets no answer, and the socket closes", async () => {
	const reads = await serve(() => conversation(1, [{ id: 1, text: "a" }]));
	const { lines } = await exchange(reads.socket, call({}, "1") + call({}, "2"));
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0]?.value?.items.map((entry) => entry.text), ["a"]);
});

test("a request over the size limit is refused and the connection closed", async () => {
	const reads = await serve(() => conversation(1, []), { requestBytes: 1024 });
	const { lines } = await exchange(reads.socket, "x".repeat(4096));
	assert.equal(lines[0]?.code, "REQUEST_TOO_LARGE");
});

test("a reader that never sends its request is disconnected at the deadline", async () => {
	const reads = await serve(() => conversation(1, []), { requestTimeoutMs: 200 });
	const { lines, ms } = await exchange(reads.socket, "");
	assert.equal(lines.length, 0);
	assert.ok(ms >= 150 && ms < 3000, `closed after ${ms} ms`);
});

test("a reply is trimmed to the reply limit and the reader continues after the last entry; one entry over the limit is refused", async () => {
	const big = "y".repeat(400);
	const entries = [1, 2, 3, 4, 5].map((id) => ({ id, text: big }));
	const reads = await serve(() => conversation(7, entries), { replyBytes: 1000 });
	const first = (await exchange(reads.socket, call())).lines[0]?.value;
	assert.ok(first);
	assert.deepEqual([first.conversationId, first.lastEntryId, first.items.length, first.more], [7, 5, 2, true]);
	const second = (await exchange(reads.socket, call({ conversationId: 7, lastEntryId: 5, after: 2 }))).lines[0]?.value;
	assert.deepEqual(second?.items.map((entry) => entry.id), [3, 4]);
	const tooLarge = await serve(() => conversation(7, [{ id: 1, text: "z".repeat(2000) }]), { replyBytes: 1000 });
	assert.equal((await exchange(tooLarge.socket, call())).lines[0]?.code, "ENTRY_TOO_LARGE");
});

test("a read is fixed to the last entry at its first page; a rewind between pages is refused so the reader starts again", async () => {
	const entries: Entry[] = [
		{ id: 1, text: "a" },
		{ id: 2, text: "b" },
	];
	let bound = conversation(1, entries);
	const reads = await serve(() => bound, { pageEntries: 1 });
	const first = (await exchange(reads.socket, call())).lines[0]?.value;
	assert.deepEqual([first?.lastEntryId, first?.more], [2, true]);
	entries.push({ id: 3, text: "appended while reading" });
	const second = (await exchange(reads.socket, call({ conversationId: 1, lastEntryId: 2, after: 1 }))).lines[0]?.value;
	assert.deepEqual([second?.items.map((entry) => entry.id), second?.more], [[2], false], "an entry appended after the first page is not part of this read");
	bound = conversation(2, [{ id: 1, text: "a" }]);
	assert.equal((await exchange(reads.socket, call({ conversationId: 1, lastEntryId: 2, after: 1 }))).lines[0]?.code, "REWOUND");
});

test("anything but one entries call is refused; a reader that disconnects mid-request leaves the socket answering", async () => {
	const reads = await serve(() => conversation(1, [{ id: 1, text: "a" }]));
	assert.equal((await exchange(reads.socket, `${JSON.stringify({ kind: "call", id: "1", method: "submit", params: {} })}\n`)).lines[0]?.code, "BAD_REQUEST");
	assert.equal((await exchange(reads.socket, "not json\n")).lines[0]?.code, "BAD_REQUEST");
	await new Promise<void>((resolve) => {
		const client = connect(reads.socket, () => {
			client.write('{"kind":"call"');
			client.destroy();
			resolve();
		});
	});
	assert.deepEqual((await exchange(reads.socket, call())).lines[0]?.value?.items.map((entry) => entry.text), ["a"]);
});

test("the socket lives in a private folder that close removes", async () => {
	const reads = await serveOwnerReads("/store", () => conversation(1, []), BACKGROUND_CONTEXT);
	assert.ok(existsSync(reads.socket));
	await reads.close();
	assert.ok(!existsSync(reads.socket));
});
