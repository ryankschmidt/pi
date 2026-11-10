import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import type { ConversationRecord, EntryRecord, Harness } from "@earendil-works/pi-durable";

// transcript.jsonl: a projection of the agent's store, beside it. One line per stored entry and one per conversation (a
// fork names its parent conversation and entry), in commit order, every branch included, and a binding line each time
// the thread is bound to a conversation and at every start. The store is the record; this file is rebuilt from it at
// every start and then appended as commits are published, so whatever a kill did to the file before (a torn line, a
// lost newline, a missing record) is replaced, never repaired. Durable never reads it back, so it cannot change the
// store. Readers take the live conversation from the last binding line and walk its fork parents.

export type TranscriptLine =
	| { seq: number | null; conversation: ConversationRecord }
	| { seq: number | null; entry: EntryRecord }
	| { seq: null; binding: { conversationId: number } };

/** A line projecting a stored record, as opposed to a binding line. */
type StoreLine = Exclude<TranscriptLine, { binding: unknown }>;

export type TranscriptWriter = {
	/** Entry and conversation ids already in the file. */
	readonly written: { entries: Set<number>; conversations: Set<number> };
	/** Append a binding line: the thread now shows this conversation. */
	bound(conversationId: number): void;
	detach(): void;
};

/**
 * Attach the projection: rebuild the file from the store, in commit order, and swap it in whole (write a sibling file,
 * then rename, so a reader never sees half a file), then append each stored commit as Durable publishes it. Call
 * before `root()` and `resume()`, so no commit lands between the rebuild and the observer.
 */
export async function attachTranscript(harness: Harness, path: string, context: Context): Promise<TranscriptWriter> {
	const stored = await harness.commit(async (tx) => {
		const conversations: ConversationRecord[] = [];
		const entries: EntryRecord[] = [];
		let cursor: Parameters<typeof tx.scanConversations>[2];
		do {
			const page = await tx.scanConversations({ order: "ascending" }, 200, cursor);
			conversations.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		for (const conversation of conversations) {
			let entryCursor: Parameters<typeof tx.scanEntries>[2];
			do {
				const page = await tx.scanEntries(
					{ conversationId: conversation.id, order: "ascending" },
					500,
					entryCursor,
				);
				// The scan is fork-aware; keep only this conversation's own entries.
				for (const entry of page.items) if (entry.conversationId === conversation.id) entries.push(entry);
				entryCursor = page.next;
			} while (entryCursor !== undefined);
		}
		return { conversations, entries };
	}, context);
	// Entry ids are Session-global and ordered, so id order is commit order.
	const records: StoreLine[] = [
		...stored.conversations.map((conversation) => ({ seq: null, conversation })),
		...stored.entries.map((entry) => ({ seq: null, entry })),
	].sort((a, b) => firstEntryId(a) - firstEntryId(b));
	const rebuilt = `${path}.rebuild-${process.pid}`;
	writeFileSync(rebuilt, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
	renameSync(rebuilt, path);
	const written = {
		entries: new Set(stored.entries.map((entry) => Number(entry.id))),
		conversations: new Set(stored.conversations.map((conversation) => Number(conversation.id))),
	};
	const append = (line: TranscriptLine) => appendFileSync(path, `${JSON.stringify(line)}\n`);
	const writeConversation = (seq: number | null, conversation: ConversationRecord) => {
		if (written.conversations.has(Number(conversation.id))) return;
		written.conversations.add(Number(conversation.id));
		append({ seq, conversation });
	};
	const writeEntry = (seq: number | null, entry: EntryRecord) => {
		if (written.entries.has(Number(entry.id))) return;
		written.entries.add(Number(entry.id));
		append({ seq, entry });
	};

	const observation = harness.observeCommits({
		advance(publication) {
			for (const change of publication.changes) {
				if (change.type === "conversation") writeConversation(publication.seq, change.value);
			}
			for (const change of publication.changes) {
				if (change.type === "entry") writeEntry(publication.seq, change.value);
			}
		},
		end() {},
	});
	return {
		written,
		bound: (conversationId) => append({ seq: null, binding: { conversationId: Number(conversationId) } }),
		detach: () => observation.detach(),
	};
}

/** A conversation sorts just before its first own entry: a fork right after the entry it starts from. */
function firstEntryId(line: StoreLine): number {
	if ("entry" in line) return Number(line.entry.id);
	return line.conversation.parent ? Number(line.conversation.parent.at) + 0.5 : 0;
}
