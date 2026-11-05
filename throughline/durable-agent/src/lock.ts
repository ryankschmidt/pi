import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

// Pi Durable has no cross-process locking: "One process owns a storage at a time" (durable README).
// The program holds `owner.lock` while it runs. A lock whose process is gone is reclaimed by the next start, so a
// killed program restarts without help; a lock whose process is alive refuses the second program.

export type LockOwner = { pid: number; startedAt: string; nonce: string };
export type StoreLock = { readonly owner: LockOwner; release(): Promise<void> };

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

export async function lockStore(directory: string): Promise<StoreLock> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "owner.lock");
	const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID() };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				await file.writeFile(JSON.stringify(owner));
				await file.sync();
			} finally {
				await file.close();
			}
			return {
				owner,
				async release() {
					const current = await readOwner(path);
					if (current?.nonce === owner.nonce) await unlink(path);
				},
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const current = await readOwner(path);
		if (current !== undefined && alive(current.pid)) throw new StoreAlreadyOwned(current);
		// Move the dead owner's lock aside under a unique name, so two starters never both remove a fresh lock.
		const aside = join(directory, `.owner-${randomUUID()}.stale`);
		try {
			await rename(path, aside);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			continue;
		}
		const moved = await readOwner(aside);
		await unlink(aside);
		if (moved !== undefined && moved.nonce !== current?.nonce && alive(moved.pid)) {
			// A live program took the lock between the read and the rename.
			throw new StoreAlreadyOwned(moved);
		}
	}
	throw new Error("STORE_LOCK_CONTENDED: could not take the store lock after three attempts");
}
