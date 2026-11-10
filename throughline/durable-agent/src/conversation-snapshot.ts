// conversation_snapshot: the agent tool that writes the calling conversation's visible entries (its live branch, in
// order) to a new file beside the store and returns its path; the store is the only record. The name binds the
// conversation and the last entry it saw, so it pins exactly what the file holds.
//
// Lifetime: a snapshot call never deletes anything. Its files live while their conversation is the thread's bound one,
// so a returned path stays readable however many calls follow. Only the binding owner withdraws them: a rebind (rewind or
// fork, program.ts) waits for snapshot writes in progress, removes every snapshot, and commits the new binding only if
// every removal succeeded; otherwise the rebind is refused, the thread stays on its branch and the agent keeps working.
// Writes that start meanwhile wait, then write nothing if their conversation is no longer bound. Program start also
// removes snapshots and killed writes' temporary files before serving. So listing the folder (0700, the agent's own
// user) never finds a withdrawn branch's snapshot. A reader that already opened a file keeps its bytes.
//
// Offering the tool is declared to every command the agent runs: PI_DURABLE_TRANSCRIPT=conversation_snapshot tells
// show-me to read only snapshots in this thread, never an older agent's transcript.jsonl.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Binding } from "./binding.ts";

export const SNAPSHOT_TOOL = "conversation_snapshot";
/** The first line of every snapshot; show-me refuses a Durable file without it (an older transcript.jsonl holds every branch). */
export const SNAPSHOT_FORMAT = "pi-durable-conversation-snapshot.v1";
/** The environment variable through which the running agent tells its commands (show-me) it offers conversation_snapshot. */
export const TRANSCRIPT_ENV = "PI_DURABLE_TRANSCRIPT";

/** The extension carrying the tool; snapshots go in `storeDir/snapshots/`, read `pageSize` entries at a time. */
export function createConversationSnapshotExtension(storeDir: string, pageSize = 500) {
	const folder = snapshotFolder(storeDir);
	process.env[TRANSCRIPT_ENV] = SNAPSHOT_TOOL;
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
					const path = await whileWriting(folder, () => writeSnapshot(folder, pageSize, api, context));
					return { output: [{ type: "text", text: path }] };
				},
			}),
		],
	});
}

/** Remove every snapshot and temporary file (program start, before serving). Returns one line per failure. */
export function clearSnapshots(storeDir: string): string[] {
	return removeSnapshots(snapshotFolder(storeDir));
}

/**
 * The rebind (program.ts): wait for snapshot writes in progress, remove every snapshot, then run `commit` (the binding
 * commit) only if every removal succeeded; otherwise throw without committing, so no withdrawn branch's file outlives it.
 */
export async function withdrawSnapshotsAndRebind(storeDir: string, commit: () => Promise<void>): Promise<void> {
	const folder = snapshotFolder(storeDir);
	const gate = gateFor(folder);
	while (gate.rebinding) await gate.rebinding.catch(() => undefined);
	const run = (async () => {
		if (gate.writers > 0) await new Promise<void>((resolve) => gate.idle.push(resolve));
		const failures = removeSnapshots(folder);
		if (failures.length > 0) {
			throw new Error(`rewind refused, the thread stays on its branch: its snapshots could not all be withdrawn (${failures.join("; ")}). Fix the folder's permissions, then rewind again.`);
		}
		await commit();
	})();
	gate.rebinding = run;
	try {
		await run;
	} finally {
		if (gate.rebinding === run) gate.rebinding = undefined;
	}
}

/** Per snapshot folder: writes in progress, and a rebind that waits for them while new writes wait for it. */
type Gate = { writers: number; idle: (() => void)[]; rebinding: Promise<void> | undefined };
const gates = new Map<string, Gate>();
function gateFor(folder: string): Gate {
	let gate = gates.get(folder);
	if (gate === undefined) gates.set(folder, (gate = { writers: 0, idle: [], rebinding: undefined }));
	return gate;
}

async function whileWriting<T>(folder: string, write: () => Promise<T>): Promise<T> {
	const gate = gateFor(folder);
	while (gate.rebinding) await gate.rebinding.catch(() => undefined);
	gate.writers++;
	try {
		return await write();
	} finally {
		gate.writers--;
		if (gate.writers === 0) for (const resolve of gate.idle.splice(0)) resolve();
	}
}

function removeSnapshots(folder: string): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [`snapshot cleanup failed: could not list ${folder} (${message(error)}); old snapshots there may remain`];
	}
	const failures: string[] = [];
	for (const name of names) {
		try {
			rmSync(join(folder, name), { recursive: true, force: true });
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

async function writeSnapshot(folder: string, pageSize: number, api: ToolExecutionApi, context: Context): Promise<string> {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const temporary = join(folder, `.tmp-${process.pid}-${api.callId.replace(/[^\w-]/g, "_")}`);
	const conversation = Number(api.conversationId);
	// One commit is one consistent read of the binding and the fork-aware visible range; each page is written as it
	// arrives, so one page is in memory at a time. The file is opened inside the callback, so a rerun starts it again.
	// A failed write leaves only its temporary file, which program start removes; this call deletes nothing.
	const last = await api.commit(async (tx) => {
		if ((await tx.doc(Binding)).conversationId !== conversation) return undefined;
		const fd = openSync(temporary, "w", 0o600);
		try {
			// The format line is written first at a fixed width and filled in once the last entry is known.
			const header = (lastEntryId: number) =>
				Buffer.from(`${JSON.stringify({ format: SNAPSHOT_FORMAT, conversationId: conversation, lastEntryId }).padEnd(HEADER_WIDTH - 1)}\n`);
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
	const path = join(folder, `${conversation}-${last}.jsonl`);
	renameSync(temporary, path);
	return path;
}

const NOT_BOUND =
	"conversation_snapshot wrote nothing: this conversation is no longer the thread's live branch (a rewind or fork moved the thread). Call conversation_snapshot again from the thread.";
