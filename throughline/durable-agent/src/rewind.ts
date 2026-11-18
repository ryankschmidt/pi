// Where a rewind forks. ThroughLine names the first turn to cut by its turn ref, verbatim; the fork is one Durable fork
// made from the owner of the entry just before that turn's user entry, so every rewind to one message is a sibling with
// the same parent and fork entry, never a chain. Nothing is deleted: every branch stays in the store with its parent.
// This file also owns the carried-ids document, because carried threads keep stock-era turn refs that a rewind reads.
// That reader is not a retiring path: turns are never deleted, so it stays while any carried thread exists. carry.ts,
// the writer, can go on its own removal date; it imports the definition from here.

import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	ResetEntry,
	UserEntry,
} from "@earendil-works/pi-durable";
import { Refused } from "./protocol.ts";

/** What has been carried into this store from a stock Pi session file, kept in the store itself (see carry.ts). */
export const CarriedDoc = defineDoc<CarriedState>({
	kind: "throughline.carried-from",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({ path: null, lastSourceId: null, ids: {} }),
});

export type CarriedState = {
	path: string | null;
	/** Id of the last stock entry carried; a re-carry starts after it. */
	lastSourceId: string | null;
	/** Stock entry id to Durable entry id: context edits target earlier entries, and stock-era turn refs resolve here. */
	ids: Record<string, number>;
};

/** The fork a rewind made: its id, the parent edge it was created with, and the newest entry it shows. */
export type Rewound = {
	conversationId: number;
	parent: { conversationId: number; at: number };
	head: number;
};

/**
 * Fork `from` just before the user entry `before` names (a Durable entry id, or a stock id the store carried). Refuses,
 * creating nothing, when `before` names no user entry visible from `from` (REWIND_POINT_NOT_IN_THREAD) or when its two
 * readings name two different ones (REWIND_REF_AMBIGUOUS).
 */
export async function rewind(harness: Harness, from: Conversation, before: string, context: Context): Promise<Rewound> {
	const cut = await resolveUserEntry(harness, from, before, context);
	const previous = (await from.entries({ order: "descending", maxEntryId: (cut.id - 1) as EntryId }, 1, undefined, context)).items[0];
	// A carried thread's carried-from note is configured after its carried entries, so a fork at an earlier entry would
	// lose it; the calling conversation's current instructions go into the fork's creating commit.
	const agent = { instructions: (await from.agent(context)).instructions ?? null };
	const fork =
		previous === undefined
			? // The first message: fork at it and start an empty context in the same creating commit, so the fork keeps its
				// parent edge and no crash can leave it showing the cut message to the model.
				await (await ownerOf(harness, cut, context)).fork(
					cut.id,
					{ ownership: { kind: "ownerless" }, agent, init: (tx, id) => tx.appendEntry(ResetEntry, id, { head: "self" }).then(() => undefined) },
					context,
				)
			: await (await ownerOf(harness, previous, context)).fork(previous.id, { ownership: { kind: "ownerless" }, agent }, context);
	const at = previous ?? cut;
	const head = (await fork.entries({ order: "descending" }, 1, undefined, context)).items[0];
	return {
		conversationId: Number(fork.id),
		parent: { conversationId: Number(at.conversationId), at: Number(at.id) },
		head: Number(head?.id ?? at.id),
	};
}

/** The one user entry visible from `from` that `before` names, read as a carried stock id and as a Durable entry id. */
async function resolveUserEntry(harness: Harness, from: Conversation, before: string, context: Context): Promise<EntryRecord> {
	const carried = (await harness.snapshot(CarriedDoc, context))?.ids[before];
	const decimal = /^[1-9][0-9]*$/.test(before) && Number.isSafeInteger(Number(before)) ? Number(before) : undefined;
	const found = new Map<number, EntryRecord>();
	for (const id of [carried, decimal]) {
		if (id === undefined) continue;
		const entry = (await from.entries({ order: "descending", minEntryId: id as EntryId, maxEntryId: id as EntryId }, 1, undefined, context)).items[0];
		if (entry !== undefined && Number(entry.id) === id && UserEntry.is(entry)) found.set(id, entry);
	}
	const [only, other] = [...found.values()];
	if (only === undefined) throw new Refused("REWIND_POINT_NOT_IN_THREAD", `turn ${before} names no user message this conversation shows`);
	if (other !== undefined) throw new Refused("REWIND_REF_AMBIGUOUS", `turn ${before} names two user messages (a carried id and an entry id)`);
	return only;
}

/** The conversation that owns `entry`: forking there at it makes the same parent edge from any branch that shows it. */
async function ownerOf(harness: Harness, entry: EntryRecord, context: Context): Promise<Conversation> {
	const owner = await harness.conversation(entry.conversationId as ConversationId, context);
	// Entries are never deleted and a visible entry's conversation always exists; reaching here is a broken store.
	if (owner === undefined) throw new Error(`conversation ${String(entry.conversationId)} of entry ${String(entry.id)} is missing`);
	return owner;
}
