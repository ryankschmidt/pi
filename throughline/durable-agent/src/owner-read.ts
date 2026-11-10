// The agent's read socket: a reader on this host (show-me) asks the running program for its thread's live branch with
// the program's own `entries` method, the one ThroughLine already calls over the link. The socket's path is written in
// the store's owner.lock, so it belongs to the live owner: a crash leaves a record whose socket nobody answers, and the
// next start writes a new record. Read-only: hello, then `entries` against the conversation bound at that hello. A
// conversation's visible range never loses or changes an entry (a rewind makes a new conversation), so paging a pinned
// conversation returns the branch that was live at hello, never a withdrawn turn and never two branches mixed.

import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@earendil-works/pi-durable";
import { ENGINE, encode, type Hello, isClientMessage, lineSplitter, PROTOCOL_VERSION, type ProgramMessage } from "./protocol.ts";

/**
 * A socket path for this process, under the per-user temporary folder: store folders reach 149 characters, past the
 * macOS socket path limit (about 104 bytes), so the path lives in the owner record instead of beside the store.
 */
export function ownerSocketPath(): string {
	return join(tmpdir(), `pi-durable-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
}

/** Listen on `path` (mode 0600) and answer read-only `entries` calls; `close` stops listening and removes the socket. */
export async function serveOwnerReads(
	path: string,
	helloFor: (conversation: Conversation) => Hello,
	current: () => Conversation,
	readEntries: (conversation: Conversation, params: Record<string, unknown>) => Promise<unknown>,
): Promise<{ close(): Promise<void> }> {
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		let pinned: Conversation | undefined;
		const send = (message: ProgramMessage) => {
			if (!socket.destroyed) socket.write(encode(message));
		};
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on(
			"data",
			lineSplitter((line) => {
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					send({ kind: "error", code: "BAD_MESSAGE", message: "a line was not JSON" });
					return;
				}
				if (!isClientMessage(message)) return send({ kind: "error", code: "BAD_MESSAGE", message: "unknown message kind" });
				if (message.kind === "hello") {
					if (message.protocol !== PROTOCOL_VERSION || message.engine !== ENGINE) {
						send({ kind: "error", code: "PROTOCOL_MISMATCH", message: `program speaks ${ENGINE} protocol ${PROTOCOL_VERSION}` });
						return socket.end();
					}
					pinned = current();
					return send(helloFor(pinned));
				}
				if (message.kind !== "call") return;
				if (pinned === undefined) return send({ kind: "error", id: message.id, code: "HELLO_REQUIRED", message: "send hello first" });
				if (message.method !== "entries") {
					return send({ kind: "error", id: message.id, code: "READ_ONLY_LINK", message: "this socket answers only entries" });
				}
				readEntries(pinned, message.params ?? {}).then(
					(value) => send({ kind: "result", id: message.id, value: value ?? null }),
					(error: unknown) => send({ kind: "error", id: message.id, code: "FAILED", message: error instanceof Error ? error.message : String(error) }),
				);
			}),
		);
	});
	// A file at this path can only be a leftover of an earlier process with this pid; this process holds the store lock.
	rmSync(path, { force: true });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	chmodSync(path, 0o600);
	return {
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// A reader still connected must not hold the program open at stop.
				for (const socket of open) socket.destroy();
				rmSync(path, { force: true });
			}),
	};
}
