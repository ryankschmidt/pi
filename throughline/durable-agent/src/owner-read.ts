// The agent's read socket: a reader on this host (show-me) asks the running program for its thread's live branch. The
// socket's path is written in the store's owner.lock, so it belongs to the live owner. Each connection carries exactly
// one `entries` request and one reply, then closes; every step has a size limit and a deadline, so a reader can neither
// hold the agent's memory or database nor wait forever on a broken owner. A read is a page of the bound conversation up
// to a fixed last entry: the first page fixes it, later pages name the same conversation and last entry, and a rewind
// between pages is refused (REWOUND) so the reader starts again. A conversation's visible range never loses or changes
// an entry, so the pages together are exactly the branch that stayed live for the whole read.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { encode, type ProgramMessage } from "./protocol.ts";

/** One page of a read: the conversation and last entry it is fixed to, the entries after `after`, and whether more follow. */
export type ReadPage = { store: string; conversationId: number; lastEntryId: number; items: unknown[]; more: boolean };
export type OwnerReads = { readonly socket: string; close(): Promise<void> };

/** Limits of one connection; a request is a few numbers, a reply is one page. */
export type ReadLimits = {
	requestBytes: number;
	replyBytes: number;
	pageEntries: number;
	requestTimeoutMs: number;
	replyTimeoutMs: number;
	connections: number;
};
export const READ_LIMITS: ReadLimits = {
	requestBytes: 64 * 1024,
	replyBytes: 64 * 1024 * 1024,
	pageEntries: 200,
	requestTimeoutMs: 5_000,
	replyTimeoutMs: 30_000,
	connections: 16,
};

/**
 * Listen on a socket in a new private folder under the per-user temporary folder (store folders reach 149 characters,
 * past the macOS socket path limit, so the path lives in the owner record) and answer one `entries` request per
 * connection. Throws if the socket cannot be created; the program then runs without it (program.ts).
 */
export async function serveOwnerReads(
	store: string,
	current: () => Conversation,
	context: Context,
	limits: ReadLimits = READ_LIMITS,
): Promise<OwnerReads> {
	// mkdtemp makes the folder 0700 before the socket exists, so no other user can reach the socket at any moment.
	const folder = mkdtempSync(join(tmpdir(), "pi-durable-"));
	const socketPath = join(folder, "read.sock");
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		answerOne(socket, store, current, context, limits);
	});
	server.maxConnections = limits.connections;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve());
		});
	} catch (error) {
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	return {
		socket: socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// A reader still connected must not hold the program open at stop.
				for (const socket of open) socket.destroy();
				rmSync(folder, { recursive: true, force: true });
			}),
	};
}

/** Read one request line within the limits, answer it, and close; anything after the first line is ignored. */
function answerOne(socket: Socket, store: string, current: () => Conversation, context: Context, limits: ReadLimits): void {
	let buffer = "";
	let answered = false;
	const reply = (message: ProgramMessage) => {
		if (!socket.destroyed) socket.end(encode(message));
	};
	socket.setEncoding("utf8");
	socket.setTimeout(limits.requestTimeoutMs, () => socket.destroy());
	socket.on("error", () => socket.destroy());
	socket.on("data", (chunk: string) => {
		if (answered) return;
		buffer += chunk;
		const end = buffer.indexOf("\n");
		if (end < 0) {
			if (buffer.length > limits.requestBytes) {
				answered = true;
				reply({ kind: "error", code: "REQUEST_TOO_LARGE", message: `a request is at most ${limits.requestBytes} bytes` });
			}
			return;
		}
		answered = true;
		socket.setTimeout(limits.replyTimeoutMs, () => socket.destroy());
		const request = parseRequest(buffer.slice(0, end));
		if ("error" in request) return reply({ kind: "error", code: "BAD_REQUEST", message: request.error });
		readPage(store, current(), request.params, context, limits).then(
			(page) => reply({ kind: "result", id: request.id, value: page }),
			(error: unknown) =>
				reply({
					kind: "error",
					id: request.id,
					code: error instanceof ReadRefused ? error.code : "FAILED",
					message: error instanceof Error ? error.message : String(error),
				}),
		);
	});
}

type Params = { conversationId?: number; lastEntryId?: number; after: number };

/** The one request a connection may carry: `{kind:"call", id, method:"entries", params:{conversationId?, lastEntryId?, after?}}`. */
function parseRequest(line: string): { id: string; params: Params } | { error: string } {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return { error: "the request was not JSON" };
	}
	if (typeof message !== "object" || message === null) return { error: "the request was not an object" };
	const { kind, id, method, params } = message as { kind?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
	if (kind !== "call" || typeof id !== "string") return { error: "send one call with an id" };
	if (method !== "entries") return { error: "this socket answers only entries" };
	const number = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
	const conversationId = number(params?.conversationId);
	const lastEntryId = number(params?.lastEntryId);
	if ((conversationId === undefined) !== (lastEntryId === undefined)) return { error: "conversationId and lastEntryId go together" };
	return { id, params: { ...(conversationId === undefined ? {} : { conversationId, lastEntryId }), after: number(params?.after) ?? 0 } };
}

class ReadRefused extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** One page of the bound conversation up to its last entry (fixed by the first page), trimmed to the reply limit. */
async function readPage(store: string, bound: Conversation, params: Params, context: Context, limits: ReadLimits): Promise<ReadPage> {
	const conversationId = Number(bound.id);
	if (params.conversationId !== undefined && params.conversationId !== conversationId) {
		throw new ReadRefused("REWOUND", "the thread was rewound during the read; read it again");
	}
	const lastEntryId = params.lastEntryId ?? Number((await bound.entries({ order: "descending" }, 1, undefined, context)).items[0]?.id ?? 0);
	if (lastEntryId === 0) return { store, conversationId, lastEntryId, items: [], more: false };
	const page = await bound.entries(
		{ order: "ascending", minEntryId: (params.after + 1) as EntryId, maxEntryId: lastEntryId as EntryId },
		limits.pageEntries,
		undefined,
		context,
	);
	const items: unknown[] = [];
	let bytes = 0;
	for (const item of page.items) {
		const size = Buffer.byteLength(JSON.stringify(item));
		if (bytes + size > limits.replyBytes) {
			if (items.length === 0) throw new ReadRefused("ENTRY_TOO_LARGE", `entry ${String(item.id)} is larger than one reply (${limits.replyBytes} bytes)`);
			return { store, conversationId, lastEntryId, items, more: true };
		}
		bytes += size;
		items.push(item);
	}
	return { store, conversationId, lastEntryId, items, more: page.next !== undefined };
}
