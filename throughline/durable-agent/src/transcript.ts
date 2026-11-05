import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import type { ConversationRecord, EntryRecord, Harness } from "@earendil-works/pi-durable";

// transcript.jsonl: one append-only file per agent, beside the store. One line per stored entry and one per new
// conversation (a fork names its parent conversation and entry), in commit order, every branch included. Durable never
// reads it back, so it cannot change the store. Readers find the live branch by walking parents from the newest
// conversation.

export type TranscriptLine =
	| { seq: number | null; conversation: ConversationRecord }
	| { seq: number | null; entry: EntryRecord };

export type TranscriptWriter = {
	/** Entry and conversation ids already in the file. */
	readonly written: { entries: Set<number>; conversations: Set<number> };
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
	// A cut-off last line ends without a newline; start the next record on a fresh line.
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		if (text.length > 0 && !text.endsWith("\n")) appendFileSync(path, "\n");
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
	const records: TranscriptLine[] = [
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
	return { written, detach: () => observation.detach() };
}

/** A conversation sorts just before its first own entry: a fork right after the entry it starts from. */
function firstEntryId(line: TranscriptLine): number {
	if ("entry" in line) return Number(line.entry.id);
	return line.conversation.parent ? Number(line.conversation.parent.at) + 0.5 : 0;
}
