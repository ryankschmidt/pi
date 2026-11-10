// conversation_snapshot: the agent tool that writes the conversation the thread shows now (the live branch only, in
// order) to a new file beside the store and returns its path. The store is the only record. A snapshot is a
// point-in-time file bound to the thread's binding: it is written only while the calling conversation is the bound
// one, it is withdrawn if a rewind or fork rebinds the thread before it is returned, and every bind removes all
// snapshots (clearSnapshots), so no file in the folder ever holds a branch the thread no longer shows.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Binding } from "./binding.ts";

export const SNAPSHOT_TOOL = "conversation_snapshot";

/** The extension carrying the tool; snapshots go in `storeDir/snapshots/`, read `pageSize` entries at a time. */
export function createConversationSnapshotExtension(storeDir: string, pageSize = 500) {
	const folder = snapshotFolder(storeDir);
	return defineExtension({
		name: "conversation-snapshot",
		tools: [
			defineTool({
				name: SNAPSHOT_TOOL,
				description:
					"Write this conversation as the user sees it now (live branch only, in order) to a new file and return its path. Skills that read the conversation, such as show-me, take this file.",
				parameters: { type: "object", properties: {} },
				// A rerun after a restart writes a fresh snapshot from the committed store.
				replay: "safe",
				execute: async (_input: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
					const written = await writeSnapshot(folder, pageSize, api, context);
					return typeof written === "string"
						? { output: [{ type: "text", text: written }] }
						: { output: [{ type: "text", text: written.refused }], isError: true };
				},
			}),
		],
	});
}

/** Remove every snapshot and temporary file: the program calls this after each bind, so no stale branch survives it. */
export function clearSnapshots(storeDir: string): void {
	const folder = snapshotFolder(storeDir);
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return;
	}
	for (const name of names) rmSync(join(folder, name), { force: true });
}

/** Write all of `bytes`, continuing after short writes; a write that makes no progress throws. */
export function writeAll(
	fd: number,
	bytes: Buffer,
	write: (fd: number, bytes: Buffer, offset: number, length: number) => number = writeSync,
): void {
	let offset = 0;
	while (offset < bytes.length) {
		const done = write(fd, bytes, offset, bytes.length - offset);
		if (done <= 0) throw new Error(`snapshot write wrote no bytes at offset ${offset} of ${bytes.length}`);
		offset += done;
	}
}

const snapshotFolder = (storeDir: string) => join(storeDir, "snapshots");
const NOT_BOUND =
	"Refused: this conversation is no longer the one the thread shows (it was rewound or forked), so no snapshot was written. Call conversation_snapshot again from the current conversation.";

async function writeSnapshot(
	folder: string,
	pageSize: number,
	api: ToolExecutionApi,
	context: Context,
): Promise<string | { refused: string }> {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const temporary = join(folder, `.tmp-${process.pid}-${api.callId.replace(/[^\w-]/g, "_")}`);
	const bound = (conversationId: number | null | undefined) => conversationId === Number(api.conversationId);
	let path: string | undefined;
	try {
		// One commit is one consistent read of the binding and the fork-aware visible range; each page is written as it
		// arrives, so one page is in memory at a time. The file is opened inside the callback, so a rerun starts it again.
		const last = await api.commit(async (tx) => {
			if (!bound((await tx.doc(Binding)).conversationId)) return undefined;
			const fd = openSync(temporary, "w", 0o600);
			try {
				let lastId = 0;
				let cursor: Parameters<typeof tx.scanEntries>[2];
				do {
					const page = await tx.scanEntries({ conversationId: api.conversationId, order: "ascending" }, pageSize, cursor);
					if (page.items.length > 0) {
						writeAll(fd, Buffer.from(page.items.map((entry) => `${JSON.stringify({ entry })}\n`).join("")));
						lastId = Number(page.items[page.items.length - 1]?.id);
					}
					cursor = page.next;
				} while (cursor !== undefined);
				return lastId;
			} finally {
				closeSync(fd);
			}
		}, context);
		if (last === undefined) return { refused: NOT_BOUND };
		path = join(folder, `${Number(api.conversationId)}-${last}.jsonl`);
		renameSync(temporary, path);
		// A bind that commits after the read above clears the folder after its commit; this second read catches one
		// that committed before the rename, so a withdrawn branch is never returned or left behind.
		if (!bound((await api.snapshot(Binding, context))?.conversationId)) {
			rmSync(path, { force: true });
			return { refused: NOT_BOUND };
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	// One snapshot on disk: an earlier path now fails visibly instead of being read stale. Another live call's
	// temporary file (same pid) is left alone; a killed program's are removed.
	for (const name of readdirSync(folder)) {
		const full = join(folder, name);
		if (full === path || name.startsWith(`.tmp-${process.pid}-`)) continue;
		rmSync(full, { force: true });
	}
	return path;
}
