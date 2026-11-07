// Carries a stock Pi session file into a Durable conversation, entry for entry, so a thread moved onto Durable keeps
// its whole history. User, assistant and tool-result messages become Durable's own entries with the original messages
// (images included, whole); a context edit becomes a Durable context edit; system prompt snapshots, model and thinking
// changes, session records and custom records stay as data-only entries, so the model context matches what the stock
// agent sent while Durable still renders its own system prompt. Re-carrying the same file appends only the entries
// after the last one carried, so a thread can move back and forth without losing or repeating anything.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type ContextEdit,
	type Conversation,
	defineDoc,
	type EntryDraft,
	type EntryId,
	type Harness,
} from "@earendil-works/pi-durable";

/** What has been carried into this store, kept in the store itself. */
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
	/** Stock entry id to Durable entry id, for context edits that target earlier entries. */
	ids: Record<string, number>;
};

export type CarrySummary = {
	path: string;
	sha256: string;
	size: number;
	at: string;
	/** Entries carried this time, by the kind they became. */
	carried: Record<string, number>;
	/** Stock entries skipped because an earlier carry already took them. */
	alreadyCarried: number;
};

type StockEntry = { type?: string; id?: string; message?: Record<string, unknown>; [key: string]: unknown };

/** Carry `path` into `conversation` in one commit, and write `carried-from.json` beside the store. */
export async function carrySession(
	harness: Harness,
	conversation: Conversation,
	path: string,
	storeDir: string,
	context: Context,
): Promise<CarrySummary> {
	const bytes = readFileSync(path);
	const entries = bytes
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as StockEntry);
	const carried: Record<string, number> = {};
	let alreadyCarried = 0;
	await harness.commit(async (tx) => {
		const state = await tx.doc(CarriedDoc);
		let start = 0;
		if (state.path === path && state.lastSourceId !== null) {
			const index = entries.findIndex((entry) => entry.id === state.lastSourceId);
			start = index < 0 ? 0 : index + 1;
			alreadyCarried = start;
		}
		for (const entry of entries.slice(start)) {
			const draft = toDraft(entry, state.ids);
			const record = await tx.appendEntry(conversation.id, draft);
			carried[draft.kind] = (carried[draft.kind] ?? 0) + 1;
			if (typeof entry.id === "string") {
				state.ids[entry.id] = Number(record.id);
				state.lastSourceId = entry.id;
			}
		}
		state.path = path;
	}, context);
	const summary: CarrySummary = {
		path,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.length,
		at: new Date().toISOString(),
		carried,
		alreadyCarried,
	};
	writeFileSync(join(storeDir, "carried-from.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

const MESSAGE_KINDS: Record<string, string> = { user: "pi.user", assistant: "pi.assistant", toolResult: "pi.tool-result" };

/** One stock session entry as the Durable entry that keeps it. */
export function toDraft(entry: StockEntry, ids: Readonly<Record<string, number>>): EntryDraft {
	if (entry.type === "message" && entry.message !== undefined) {
		const kind = MESSAGE_KINDS[String(entry.message.role)];
		if (kind === "pi.tool-result") return { kind, model: [entry.message as never], data: { diagnostics: [] } };
		if (kind !== undefined) return { kind, model: [entry.message as never] };
	}
	if (entry.type === "custom_message" && typeof entry.content !== "undefined") {
		return {
			kind: "throughline.carried-custom-message",
			model: [{ role: "user", content: entry.content, timestamp: Date.parse(String(entry.timestamp)) || 0 } as never],
			data: { customType: String(entry.customType ?? "") },
		};
	}
	if (entry.type === "context_edit" && typeof entry.targetId === "string" && ids[entry.targetId] !== undefined) {
		const target = ids[entry.targetId] as EntryId;
		const edit: ContextEdit =
			entry.replacement === null || entry.replacement === undefined
				? { target, action: "omit" }
				: { target, action: "replace", messages: [entry.replacement as never] };
		return { kind: "throughline.carried-context-edit", data: entry as never, edits: [edit] };
	}
	// Records that never reached the model as messages (and system prompt snapshots, which Durable renders itself).
	return { kind: "throughline.carried-record", data: entry as never };
}
