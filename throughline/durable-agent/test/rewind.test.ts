// Where a rewind forks (rewind.ts), on a real Durable store: from the owner of the entry before the cut user entry, so
// many forks start from one turn as siblings; at the first message with a reset in the fork's creating commit; through
// a carried store's stock ids; refused, creating nothing, when the turn ref is not a visible user entry or is ambiguous.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, createRegistry, type EntryDraft, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { carrySession } from "../src/carry.ts";
import { CarriedDoc, rewind } from "../src/rewind.ts";

const context = BACKGROUND_CONTEXT;
const stockFixture = fileURLToPath(new URL("./fixtures/stock-session.jsonl", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function open() {
	const dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
	roots.push(dir);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "store.sqlite")),
		{ models: createModels(), registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: dir }) },
		context,
	);
	return { dir, harness, root: await harness.root(context, { agent: { cwd: dir } }) };
}

const user = (text: string): EntryDraft => ({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 } as never] });
const answer = (text: string): EntryDraft => ({
	kind: "pi.assistant",
	model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 } as never],
});

/** Append one user message and its answer to `conversation`; returns their entry ids. */
async function exchange(harness: Harness, conversation: Conversation, said: string, replied: string): Promise<{ user: number; answer: number }> {
	return await harness.commit(async (tx) => {
		const asked = await tx.appendEntry(conversation.id, user(said));
		const told = await tx.appendEntry(conversation.id, answer(replied));
		return { user: Number(asked.id), answer: Number(told.id) };
	}, context);
}

/** The text of every message the model would see in `conversation`. */
async function modelTexts(conversation: Conversation): Promise<string[]> {
	return (await conversation.context(context)).messages.map((message) => {
		const content = (message as { content: unknown }).content;
		return typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
	});
}

const conversationOf = async (harness: Harness, id: number) => {
	const found = await harness.conversation(id as ConversationId, context);
	assert.ok(found, `conversation ${id} exists`);
	return found;
};

function conversationCount(dir: string): number {
	const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
	try {
		return Number((db.prepare("select count(*) as n from conversations").get() as { n: number }).n);
	} finally {
		db.close();
	}
}

test("a rewind before turn 2 forks the owner of turn 1's answer at it; the root keeps every entry", async () => {
	const { harness, root } = await open();
	const amber = await exchange(harness, root, "amber", "ok amber");
	const birch = await exchange(harness, root, "birch", "ok birch");
	await exchange(harness, root, "cobalt", "ok cobalt");
	const before = (await root.entries({ order: "ascending" }, 100, undefined, context)).items.length;
	const forked = await rewind(harness, root, String(birch.user), context);
	assert.deepEqual(forked.parent, { conversationId: Number(root.id), at: amber.answer });
	assert.equal(forked.head, amber.answer);
	assert.deepEqual(await modelTexts(await conversationOf(harness, forked.conversationId)), ["amber", "ok amber"]);
	assert.equal((await root.entries({ order: "ascending" }, 100, undefined, context)).items.length, before, "nothing is deleted");
	await harness.close(context);
});

test("rewinds to one message from the root and from a fork are siblings; a rewind inside a fork names the fork as parent", async () => {
	const { harness, root } = await open();
	await exchange(harness, root, "amber", "ok amber");
	const birch = await exchange(harness, root, "birch", "ok birch");
	const first = await rewind(harness, root, String(birch.user), context);
	const f1 = await conversationOf(harness, first.conversationId);
	const delta = await exchange(harness, f1, "delta", "ok delta");
	// From F1 to its own first message: the entry before it is the root's answer, so the fork is F1's sibling.
	const second = await rewind(harness, f1, String(delta.user), context);
	assert.deepEqual(second.parent, first.parent, "same parent and fork entry: many forks from one turn");
	assert.notEqual(second.conversationId, first.conversationId);
	const echo = await exchange(harness, f1, "echo", "ok echo");
	const third = await rewind(harness, f1, String(echo.user), context);
	assert.deepEqual(third.parent, { conversationId: first.conversationId, at: delta.answer }, "a fork of a fork names its parent");
	assert.deepEqual(await modelTexts(await conversationOf(harness, third.conversationId)), ["amber", "ok amber", "delta", "ok delta"]);
	await harness.close(context);
});

test("a rewind to the first message forks at it with a reset in the creating commit: a parent edge and an empty context", async () => {
	const { harness, root } = await open();
	const amber = await exchange(harness, root, "amber", "ok amber");
	const forked = await rewind(harness, root, String(amber.user), context);
	assert.deepEqual(forked.parent, { conversationId: Number(root.id), at: amber.user });
	const fork = await conversationOf(harness, forked.conversationId);
	assert.deepEqual(await modelTexts(fork), [], "the model sees nothing before the next message");
	const own = (await fork.entries({ order: "ascending", minEntryId: (amber.user + 1) as never }, 10, undefined, context)).items;
	assert.equal(own.length, 1);
	assert.equal(own[0]?.kind, "pi.reset");
	assert.equal(own[0]?.head, own[0]?.id, "the reset starts the context at itself");
	assert.equal(forked.head, Number(own[0]?.id));
	await harness.close(context);
});

test("a carried store resolves a stock turn ref through its carried ids; an all-digit ref that names no visible user entry is refused and creates nothing", async () => {
	const { dir, harness, root } = await open();
	const session = join(dir, "session.jsonl");
	writeFileSync(
		session,
		[
			{ type: "session", id: "s-9", version: 3 },
			{ type: "message", id: "15790175", message: { role: "user", content: "stock question", timestamp: 1 } },
			{ type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "stock answer" }], timestamp: 2 } },
			{ type: "message", id: "e3", message: { role: "user", content: "stock follow-up", timestamp: 3 } },
		]
			.map((line) => JSON.stringify(line))
			.join("\n"),
	);
	await carrySession(harness, root, session, dir, context);
	const ids = (await harness.snapshot(CarriedDoc, context))?.ids ?? {};
	const followUp = await rewind(harness, root, "e3", context);
	assert.deepEqual(followUp.parent, { conversationId: Number(root.id), at: ids.e2 });
	// An all-digit stock id resolves through the carried map, never as a Durable entry id.
	const digits = await rewind(harness, root, "15790175", context);
	assert.ok(digits.parent.at < (ids["15790175"] ?? 0), "forks before the carried message (at the carried session record)");
	const count = (await root.entries({ order: "ascending" }, 100, undefined, context)).items.length;
	await assert.rejects(rewind(harness, root, "5437968", context), { name: "REWIND_POINT_NOT_IN_THREAD" });
	await assert.rejects(rewind(harness, root, "e2", context), { name: "REWIND_POINT_NOT_IN_THREAD" }, "an answer is not a turn's user entry");
	assert.equal((await root.entries({ order: "ascending" }, 100, undefined, context)).items.length, count);
	await harness.close(context);
	assert.equal(conversationCount(dir), 3, "the root and the two forks; the refusals created nothing");
});

test("the stock session fixture's user turn resolves through the carried map", async () => {
	const { harness, root } = await open();
	await carrySession(harness, root, stockFixture, mkdtempSync(join(tmpdir(), "rewind-carry-")), context);
	const ids = (await harness.snapshot(CarriedDoc, context))?.ids ?? {};
	const forked = await rewind(harness, root, "e3", context);
	assert.ok(forked.parent.at < (ids.e3 ?? 0));
	await harness.close(context);
});

test("a ref read both as a carried id and as an entry id is refused; a ref visible only on another branch is refused", async () => {
	const { dir, harness, root } = await open();
	const amber = await exchange(harness, root, "amber", "ok amber");
	const birch = await exchange(harness, root, "birch", "ok birch");
	await harness.commit(async (tx) => {
		(await tx.doc(CarriedDoc)).ids[String(birch.user)] = amber.user;
	}, context);
	await assert.rejects(rewind(harness, root, String(birch.user), context), { name: "REWIND_REF_AMBIGUOUS" });
	const fork = await conversationOf(harness, (await rewind(harness, root, String(amber.user), context)).conversationId);
	const own = await exchange(harness, fork, "only in the fork", "ok");
	await assert.rejects(rewind(harness, root, String(own.user), context), { name: "REWIND_POINT_NOT_IN_THREAD" });
	await harness.close(context);
	assert.equal(conversationCount(dir), 2, "refusals created nothing");
});

test("the fork carries the calling conversation's current instructions when its fork entry predates them", async () => {
	const { harness, root } = await open();
	await exchange(harness, root, "amber", "ok amber");
	const birch = await exchange(harness, root, "birch", "ok birch");
	await root.configure({ instructions: "This thread was carried onto Pi Durable." }, context);
	const forked = await rewind(harness, root, String(birch.user), context);
	assert.equal((await (await conversationOf(harness, forked.conversationId)).agent(context)).instructions, "This thread was carried onto Pi Durable.");
	await harness.close(context);
});

test("after many rewinds the store's conversations table is one connected record: every fork names a parent that reaches the root, and no entry is deleted", async () => {
	const { dir, harness, root } = await open();
	const amber = await exchange(harness, root, "amber", "ok amber");
	const birch = await exchange(harness, root, "birch", "ok birch");
	await exchange(harness, root, "cobalt", "ok cobalt");
	const readStore = () => {
		const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
		try {
			const conversations = (db.prepare("select id, record from conversations order by id").all() as { id: number; record: string }[]).map(
				(row) => ({ id: Number(row.id), parent: (JSON.parse(row.record) as { parent?: { conversationId: string | number; at: string | number } }).parent }),
			);
			const entries = (db.prepare("select id, conversation_id from entries order by id").all() as { id: number; conversation_id: number }[]).map(
				(row) => `${row.id}@${row.conversation_id}`,
			);
			return { conversations, entries };
		} finally {
			db.close();
		}
	};
	const start = readStore();
	// The live proof's sequence: two rewinds to one message (siblings), a fork of a fork, and a first-message fork.
	const f1 = await rewind(harness, root, String(birch.user), context);
	const f2 = await rewind(harness, root, String(birch.user), context);
	const f2c = await conversationOf(harness, f2.conversationId);
	const delta = await exchange(harness, f2c, "delta", "ok delta");
	const question = await exchange(harness, f2c, "which words", "amber, delta");
	const f3 = await rewind(harness, f2c, String(question.user), context);
	const f4 = await rewind(harness, root, String(amber.user), context);
	const end = readStore();
	await harness.close(context);

	assert.deepEqual(
		end.conversations.map((c) => c.id),
		[Number(root.id), f1.conversationId, f2.conversationId, f3.conversationId, f4.conversationId].sort((a, b) => a - b),
		"one store holds the root and every fork; no second store or transcript is made",
	);
	const byId = new Map(end.conversations.map((c) => [c.id, c]));
	assert.equal(byId.get(Number(root.id))?.parent, undefined, "the root has no parent");
	for (const conversation of end.conversations) {
		if (conversation.id === Number(root.id)) continue;
		const seen = new Set<number>();
		let at: number | undefined = conversation.id;
		while (at !== undefined && at !== Number(root.id)) {
			assert.ok(!seen.has(at), `conversation ${conversation.id}'s parent chain has no cycle`);
			seen.add(at);
			const parent: { conversationId: string | number; at: string | number } | undefined = byId.get(at)?.parent;
			assert.ok(parent, `conversation ${at} names a parent`);
			assert.ok(byId.has(Number(parent.conversationId)), `conversation ${at}'s parent ${parent.conversationId} is in the same store`);
			at = Number(parent.conversationId);
		}
		assert.equal(at, Number(root.id), `conversation ${conversation.id} reaches the root`);
	}
	assert.deepEqual(byId.get(f1.conversationId)?.parent, byId.get(f2.conversationId)?.parent, "F1 and F2 are siblings from one turn");
	assert.equal(Number(byId.get(f3.conversationId)?.parent?.conversationId), f2.conversationId, "F3 names F2");
	assert.equal(Number(byId.get(f3.conversationId)?.parent?.at), delta.answer, "F3 forks at the answer before the cut question");
	for (const entry of start.entries) assert.ok(end.entries.includes(entry), `entry ${entry} is still in the store with its owner`);
	assert.equal(new Set(end.entries).size, end.entries.length, "every entry is stored once");
});
