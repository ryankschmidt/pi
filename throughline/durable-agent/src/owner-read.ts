// The agent's read socket: a reader on this host (show-me) asks the running program for its thread's live branch. The
// socket's path is written in the store's owner.lock, so it belongs to the live owner. Each connection carries exactly
// one `entries` request and one reply, then closes; both are counted in bytes before anything is parsed or sent, and
// each phase has an absolute deadline, so a reader can neither hold the agent's memory or database nor keep a slot. A
// read is a page of the bound conversation up to a fixed last entry: the first page fixes it, later pages name the same
// conversation and last entry. A rewind never waits on a read: the program's rebind generation (BoundNow) is odd while
// a rebind runs and moves on at its start and end; a rebind abandons every read in flight with REWOUND, a read that
// starts during a rebind is refused, and a reply is sent only if the generation has not moved since its read began, in
// the same step as the send. So a reply is the branch live for the whole read, never a withdrawn one, and the reader
// starts again on REWOUND.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { encode, type ProgramMessage } from "./protocol.ts";

/** One page of a read: the conversation and last entry it is fixed to, the entries after `after`, and whether more follow. */
export type ReadPage = { store: string; conversationId: number; lastEntryId: number; items: unknown[]; more: boolean };
/** `abandon` ends every read in flight with REWOUND; the program calls it when a rebind starts. */
export type OwnerReads = { readonly socket: string; abandon(): void; close(): Promise<void> };
/** The program's bound conversation now, and its rebind generation (odd while a rebind runs). */
export type BoundNow = { generation(): number; conversation(): Conversation };

/** Limits of one connection, in bytes and milliseconds from the moment the phase starts. */
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
export async function serveOwnerReads(store: string, bound: BoundNow, context: Context, limits: ReadLimits = READ_LIMITS): Promise<OwnerReads> {
	// mkdtemp makes the folder 0700 before the socket exists, so no other user can reach the socket at any moment.
	const folder = mkdtempSync(join(tmpdir(), "pi-durable-"));
	const socketPath = join(folder, "read.sock");
	const open = new Set<Socket>();
	const inFlight = new Set<() => void>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		answerOne(socket, store, bound, inFlight, context, limits);
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
		abandon: () => {
			for (const end of [...inFlight]) end();
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// A reader still connected must not hold the program open at stop.
				for (const socket of open) socket.destroy();
				rmSync(folder, { recursive: true, force: true });
			}),
	};
}

/** Read one request line within the byte limit and deadline, answer it within the reply deadline, and close. */
function answerOne(socket: Socket, store: string, bound: BoundNow, inFlight: Set<() => void>, context: Context, limits: ReadLimits): void {
	const chunks: Buffer[] = [];
	let received = 0;
	let answered = false;
	// Absolute deadlines, not idle timeouts: a peer sending a byte now and then still loses its slot on time.
	let deadline = setTimeout(() => socket.destroy(), limits.requestTimeoutMs);
	socket.on("close", () => clearTimeout(deadline));
	socket.on("error", () => socket.destroy());
	let replied = false;
	const reply = (message: ProgramMessage) => {
		if (replied) return;
		replied = true;
		if (!socket.destroyed) socket.end(encode(message));
	};
	socket.on("data", (chunk: Buffer) => {
		if (answered) return;
		const newline = chunk.indexOf(0x0a);
		const taken = newline < 0 ? chunk : chunk.subarray(0, newline);
		received += taken.length;
		// Counted before parsing, whether or not the newline arrived in this chunk.
		if (received > limits.requestBytes) {
			answered = true;
			return reply({ kind: "error", code: "REQUEST_TOO_LARGE", message: `a request is at most ${limits.requestBytes} bytes` });
		}
		chunks.push(taken);
		if (newline < 0) return;
		answered = true;
		clearTimeout(deadline);
		deadline = setTimeout(() => socket.destroy(), limits.replyTimeoutMs);
		const request = parseRequest(Buffer.concat(chunks).toString("utf8"));
		if ("error" in request) return reply({ kind: "error", code: "BAD_REQUEST", message: request.error });
		const rewound = () => reply({ kind: "error", id: request.id, code: "REWOUND", message: "the thread was rewound during the read; read it again" });
		const began = bound.generation();
		if (began % 2 === 1) return rewound();
		// Abandoned at a rebind, or by a reader that left: the read's own work is not awaited by anything.
		inFlight.add(rewound);
		socket.on("close", () => inFlight.delete(rewound));
		readPage(store, bound.conversation(), request.params, context, limits, request.id).then(
			(page) => (bound.generation() === began ? reply({ kind: "result", id: request.id, value: page }) : rewound()),
			(error: unknown) =>
				reply({
					kind: "error",
					id: request.id,
					code: error instanceof ReadRefused ? error.code : "FAILED",
					message: error instanceof Error ? error.message : String(error),
				}),
		).finally(() => inFlight.delete(rewound));
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
	if (kind !== "call" || typeof id !== "string" || id.length > 128) return { error: "send one call with an id of at most 128 characters" };
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

/** One page of the bound conversation up to its last entry (fixed by the first page), trimmed so the whole reply fits. */
async function readPage(store: string, bound: Conversation, params: Params, context: Context, limits: ReadLimits, id: string): Promise<ReadPage> {
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
	// The reply's bytes without items, then each item with its comma: the encoded reply never exceeds replyBytes.
	let bytes = Buffer.byteLength(encode({ kind: "result", id, value: { store, conversationId, lastEntryId, items: [], more: true } }));
	const items: unknown[] = [];
	for (const item of page.items) {
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (bytes + size > limits.replyBytes) {
			if (items.length === 0) throw new ReadRefused("ENTRY_TOO_LARGE", `entry ${String(item.id)} is larger than one reply (${limits.replyBytes} bytes)`);
			return { store, conversationId, lastEntryId, items, more: true };
		}
		bytes += size;
		items.push(item);
	}
	return { store, conversationId, lastEntryId, items, more: page.next !== undefined };
}
