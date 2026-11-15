// search_history's logic over stored entries shaped as Durable writes them: a word only in an entry a compaction
// summarized is still found and marked compacted, and one entry is read in full by its number.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lastReset, searchHistory, type WireEntry } from "../src/history.ts";

const user = (id: number, text: string): WireEntry => ({ id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }] }] });
const assistant = (id: number, text: string, call?: { name: string; arguments: unknown }): WireEntry => ({
	id,
	kind: "pi.assistant",
	model: [
		{
			role: "assistant",
			content: [{ type: "text", text }, ...(call ? [{ type: "toolCall" as const, id: `c${id}`, ...call }] : [])],
		},
	],
});
const result = (id: number, toolName: string, text: string): WireEntry => ({
	id,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId: `c${id - 1}`, toolName, content: [{ type: "text", text }], isError: false }],
});

// Entries 1-5 before a reset, 6-9 summarized by the compaction at 10 (head 9), 9 onward active.
const entries: WireEntry[] = [
	user(1, "old task before the reset"),
	assistant(2, "done"),
	{ id: 5, kind: "pi.reset", model: [{ role: "user", content: [{ type: "text", text: "handoff text" }] }] },
	user(6, "the build id is marigold-417"),
	assistant(7, "running it", { name: "bash", arguments: { command: "make marigold" } }),
	result(8, "bash", "ok"),
	assistant(9, "recent answer"),
	{ id: 10, kind: "pi.compaction", head: 9, model: [{ role: "user", content: [{ type: "text", text: "summary of 6-8" }] }] },
	assistant(11, "searching", { name: "search_history", arguments: { query: "marigold" } }),
];
const marks = { activeFrom: 9, lastReset: lastReset(entries) };

test("a word only in an entry before the compaction is found, marked compacted; the search's own call is skipped", () => {
	const page = searchHistory(entries, { query: "marigold" }, marks);
	assert.deepEqual(
		page.results.map((hit) => [hit.entry, hit.kind, hit.context]),
		[
			[7, "assistant", "compacted"],
			[6, "user", "compacted"],
		],
	);
	assert.equal(page.active_from, 9);
});

test("one entry is read in full by number; entries before the reset say so; active entries say active", () => {
	assert.deepEqual(searchHistory(entries, { entry: 6 }, marks).results, [
		{ entry: 6, kind: "user", context: "compacted", text: "the build id is marigold-417" },
	]);
	assert.equal(searchHistory(entries, { entry: 1 }, marks).results[0]?.context, "before reset");
	assert.equal(searchHistory(entries, { entry: 9 }, marks).results[0]?.context, "active");
	assert.equal(lastReset(entries), 5);
});

test("tool filter, kind filter, order and paging", () => {
	assert.deepEqual(
		searchHistory(entries, { tool: "bash" }, marks).results.map((hit) => hit.entry),
		[8, 7],
	);
	assert.deepEqual(
		searchHistory(entries, { kind: "tool_call", order: "oldest" }, marks).results.map((hit) => hit.entry),
		[7],
	);
	const first = searchHistory(entries, { limit: 2 }, marks);
	assert.equal(first.next_offset, 2);
	assert.equal(searchHistory(entries, { limit: 2, offset: first.next_offset ?? 0 }, marks).offset, 2);
});
