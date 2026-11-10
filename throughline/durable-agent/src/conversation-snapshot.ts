// conversation_snapshot: the agent tool that writes the calling conversation's visible entries (its live branch, in
// order) to a new file beside the store and returns its path; the store is the only record. The name binds the
// conversation and the last entry it saw, so it pins exactly what the file holds.
//
// Lifetime: a snapshot file lives while its conversation is the thread's bound one. A snapshot call never removes a file
// of its own conversation, so a path it returned stays readable for the consumer it was handed to, however many calls
// follow. Snapshots of any other conversation are removed when the thread binds another conversation (a rewind or fork,
// see program.ts), again at program start before anything is served, and again by the next snapshot call if either
// removal failed; failures are reported, never stopping the agent. A call running in a conversation that is no longer
// bound writes nothing, and a file finished while a rewind landed is removed by its own call. So listing the folder (0700,
// the agent's own user) finds only the live branch's snapshots. A reader that already opened a file keeps its bytes.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Binding, type StoredBinding } from "./binding.ts";

export const SNAPSHOT_TOOL = "conversation_snapshot";
/** The first line of every snapshot; show-me refuses a Durable file without it (an older transcript.jsonl holds every branch). */
export const SNAPSHOT_FORMAT = "pi-durable-conversation-snapshot.v1";

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
					const { path, cleanupFailures } = await writeSnapshot(folder, pageSize, api, context);
					// Cleanup is not correctness, but a failure must be seen: it is stored with this call's result in the thread.
					for (const failure of cleanupFailures) {
						process.stderr.write(`${failure}\n`);
						api.diagnostic({ severity: "warn", code: "snapshot-cleanup-failed", message: failure });
					}
					return { output: [{ type: "text", text: path }] };
				},
			}),
		],
	});
}

/**
 * Remove every snapshot and temporary file (the program calls this at start and after each rebind). Returns one line
 * per failure; only an absent folder counts as nothing to remove.
 */
export function clearSnapshots(storeDir: string): string[] {
	return removeSnapshots(snapshotFolder(storeDir), () => false);
}

/** The name an older agent's transcript.jsonl is moved to; show-me reads the legacy format only under transcript.jsonl. */
export const LEGACY_TRANSCRIPT_ASIDE = "transcript.superseded-by-conversation-snapshot.jsonl";

/**
 * Move an older agent's transcript.jsonl aside (program start). That agent kept it current; this one never writes it, so
 * left in place a replayed old skill body could read it as current while it misses every new turn. It is derived from
 * the store, and an older agent rolled back in rebuilds it whole at its start. A failure is logged; the agent still starts.
 */
export function setAsideLegacyTranscript(storeDir: string, log: (line: string) => void): void {
	try {
		renameSync(join(storeDir, "transcript.jsonl"), join(storeDir, LEGACY_TRANSCRIPT_ASIDE));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`could not set aside ${join(storeDir, "transcript.jsonl")} (${message(error)}); show-me may read it as current`);
	}
}

function removeSnapshots(folder: string, keep: (name: string) => boolean): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [`snapshot cleanup failed: could not list ${folder} (${message(error)}); old snapshots there may remain`];
	}
	const failures: string[] = [];
	for (const name of names) {
		if (keep(name)) continue;
		try {
			rmSync(join(folder, name), { force: true });
		} catch (error) {
			failures.push(`snapshot cleanup failed: could not remove ${join(folder, name)} (${message(error)})`);
		}
	}
	return failures;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
const HEADER_WIDTH = 160;

async function writeSnapshot(
	folder: string,
	pageSize: number,
	api: ToolExecutionApi,
	context: Context,
): Promise<{ path: string; cleanupFailures: string[] }> {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const temporary = join(folder, `.tmp-${process.pid}-${api.callId.replace(/[^\w-]/g, "_")}`);
	const conversation = Number(api.conversationId);
	const bound = (binding: StoredBinding | undefined) => binding?.conversationId === conversation;
	let path: string;
	try {
		// One commit is one consistent read of the binding and the fork-aware visible range; each page is written as it
		// arrives, so one page is in memory at a time. The file is opened inside the callback, so a rerun starts it again.
		const last = await api.commit(async (tx) => {
			if (!bound(await tx.doc(Binding))) return undefined;
			const fd = openSync(temporary, "w", 0o600);
			try {
				// The format line is written first at a fixed width and filled in once the last entry is known.
				const header = (lastEntryId: number) =>
					Buffer.from(`${JSON.stringify({ format: SNAPSHOT_FORMAT, conversationId: Number(api.conversationId), lastEntryId }).padEnd(HEADER_WIDTH - 1)}\n`);
				writeAll(fd, header(0));
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
				writeAll(fd, header(lastId), (handle, bytes, offset, length) => writeSync(handle, bytes, offset, length, offset));
				return lastId;
			} finally {
				closeSync(fd);
			}
		}, context);
		if (last === undefined) throw new Error(NOT_BOUND);
		path = join(folder, `${conversation}-${last}.jsonl`);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	// A rebind that committed while this file was written: its cleanup may have run before the rename, so this call
	// removes its own file (program.ts clears after the binding commit, so one of the two always sees the other).
	if (!bound(await api.snapshot(Binding, context))) {
		rmSync(path, { force: true });
		throw new Error(NOT_BOUND);
	}
	// Retry what a failed rebind cleanup left: other conversations' snapshots and a killed program's temporary files.
	// This conversation's snapshots and this program's in-flight temporary files stay.
	const cleanupFailures = removeSnapshots(folder, (name) => name.startsWith(`${conversation}-`) || name.startsWith(`.tmp-${process.pid}-`));
	return { path, cleanupFailures };
}

const NOT_BOUND =
	"conversation_snapshot wrote nothing: this conversation is no longer the thread's live branch (a rewind or fork moved the thread). Call conversation_snapshot again from the thread.";
