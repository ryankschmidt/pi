import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import type { ConversationRecord, EntryRecord, Harness } from "@earendil-works/pi-durable";

// transcript.jsonl: one append-only file per agent, beside the store. One line per stored entry and one per new
// conversation (a fork names its parent conversation and entry), in commit order, every branch included, and a binding
// line each time the thread is bound to a conversation and at every start. Durable never reads it back, so it cannot
// change the store. Readers take the live conversation from the last binding line and walk its fork parents.

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

function readWritten(path: string): { entries: Set<number>; conversations: Set<number> } {
	const written = { entries: new Set<number>(), conversations: new Set<number>() };
	if (!existsSync(path)) return written;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		let value: Partial<TranscriptLine>;
		try {
			value = JSON.parse(line);
		} catch {
			// A line cut off by a kill mid-write is skipped; its record is written again below.
			continue;
		}
		if ("entry" in value && value.entry) written.entries.add(Number(value.entry.id));
		if ("conversation" in value && value.conversation) written.conversations.add(Number(value.conversation.id));
	}
	return written;
}

/**
 * Attach the projection: first copy what the store holds that the file lacks (a kill can land between a stored commit
 * and its line), then append each stored commit as Durable publishes it. Call before `root()` and `resume()`, so no
 * commit lands between the catch-up and the observer.
 */
export async function attachTranscript(harness: Harness, path: string, context: Context): Promise<TranscriptWriter> {
	const written = readWritten(path);
	// Only the program holding the store lock writes this file, so a kill can tear only its last line. Cut the fragment
	// off; the catch-up below writes that record again, and every line of the file parses.
	if (existsSync(path)) {
		const bytes = readFileSync(path);
		if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) truncateSync(path, bytes.lastIndexOf(0x0a) + 1);
	}
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

	const missing = await harness.commit(async (tx) => {
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
		...missing.conversations.map((conversation) => ({ seq: null, conversation })),
		...missing.entries.map((entry) => ({ seq: null, entry })),
	].sort((a, b) => firstEntryId(a) - firstEntryId(b));
	for (const record of records) {
		if ("conversation" in record) writeConversation(null, record.conversation);
		else writeEntry(null, record.entry);
	}

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
