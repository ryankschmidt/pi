import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

// Pi Durable has no cross-process locking: "One process owns a storage at a time" (durable README).
// The program holds `owner.lock` while it runs. A lock whose process is gone is reclaimed by the next start, so a
// killed program restarts without help; a lock whose process is alive refuses the second program.

/**
 * Whether a reader can ask this owner for the live branch (owner-read.ts). Older agents' records carry no `reads`;
 * this program's always do, so a reader never mistakes a current owner for an older one.
 */
export type Reads = { state: "starting" } | { state: "ready"; socket: string } | { state: "unavailable"; reason: string };
export type LockOwner = { pid: number; startedAt: string; nonce: string; reads?: Reads };
export type StoreLock = { readonly owner: LockOwner; setReads(reads: Reads): Promise<void>; release(): Promise<void> };

/**
 * The permanent marker this program writes in a store folder once it has fully started with its read socket serving,
 * just before it can serve a turn or a rewind, and never removes: from then on the store's old transcript.jsonl is never
 * current, so show-me never reads it (only a store never marked keeps show-me 2.0.7's reading).
 * Empty: its existence is the whole record, so it cannot be half-written.
 */
export const OWNER_READS_MARKER = "owner-reads.v1";

export class StoreAlreadyOwned extends Error {
	readonly code = "STORE_ALREADY_OWNED";
	readonly owner: LockOwner;
	constructor(owner: LockOwner) {
		super(`STORE_ALREADY_OWNED: the agent store is open in process ${owner.pid} since ${owner.startedAt}`);
		this.owner = owner;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value === "object" && value !== null && "pid" in value && Number.isSafeInteger(value.pid)) {
			return value as LockOwner;
		}
		return undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		// A half-written lock from a process killed while writing it has no live owner.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/**
 * Take the store's lock: publish this owner's record (reads "starting") atomically, so no reader ever sees a partial
 * record. The program marks the store (markStore) only once it has fully started.
 */
export async function lockStore(directory: string): Promise<StoreLock> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "owner.lock");
	const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID(), reads: { state: "starting" } };
	for (let attempt = 0; attempt < 3; attempt++) {
		const draft = await writeDraft(directory, owner);
		try {
			// link() publishes the complete draft under the lock's name, or fails with EEXIST: never a half-written lock.
			await link(draft, path);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			await unlink(draft);
			await reclaimIfDead(directory, path);
			continue;
		}
		await unlink(draft);
		const lock: StoreLock = {
			owner,
			async setReads(reads) {
				const current = await readOwner(path);
				if (current?.nonce !== owner.nonce) return;
				owner.reads = reads;
				// rename() replaces the record whole; a reader sees the old record or the new one.
				await rename(await writeDraft(directory, owner), path);
			},
			async release() {
				const current = await readOwner(path);
				if (current?.nonce === owner.nonce) await unlink(path);
			},
		};
		return lock;
	}
	throw new Error("STORE_LOCK_CONTENDED: could not take the store lock after three attempts");
}

/** Write the record to a unique file in the store folder, flushed, ready to be linked or renamed into place. */
async function writeDraft(directory: string, owner: LockOwner): Promise<string> {
	const draft = join(directory, `.owner-${randomUUID()}.draft`);
	const file = await open(draft, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await file.writeFile(JSON.stringify(owner));
		await file.sync();
	} finally {
		await file.close();
	}
	return draft;
}

/** Refuse if the lock's owner is alive; otherwise move its dead lock aside so the next attempt can take it. */
async function reclaimIfDead(directory: string, path: string): Promise<void> {
	const current = await readOwner(path);
	if (current !== undefined && alive(current.pid)) throw new StoreAlreadyOwned(current);
	// Move the dead owner's lock aside under a unique name, so two starters never both remove a fresh lock.
	const aside = join(directory, `.owner-${randomUUID()}.stale`);
	try {
		await rename(path, aside);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		return;
	}
	const moved = await readOwner(aside);
	await unlink(aside);
	if (moved !== undefined && moved.nonce !== current?.nonce && alive(moved.pid)) {
		// A live program took the lock between the read and the rename.
		throw new StoreAlreadyOwned(moved);
	}
}

/**
 * Create the permanent marker once, flushed with its folder. An existing regular file is kept; anything else at that
 * name (a link, dangling or not, a folder) is not a marker this program wrote, so it is replaced: show-me counts any
 * entry at that name as marked without following it, and the writer must agree.
 */
export async function markStore(directory: string): Promise<void> {
	const path = join(directory, OWNER_READS_MARKER);
	for (let attempt = 0; ; attempt++) {
		try {
			const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			await file.sync();
			await file.close();
			break;
		} catch (error) {
			if (errorCode(error) !== "EEXIST" || attempt > 0) throw error;
			if ((await lstat(path)).isFile()) return;
			await rm(path, { recursive: true });
		}
	}
	const folder = await open(directory, constants.O_RDONLY);
	try {
		await folder.sync();
	} finally {
		await folder.close();
	}
}
