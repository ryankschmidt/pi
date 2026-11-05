// The messages between a client and the Pi Durable agent program: one JSON object per line.
// Kinds borrow Chord v2's meanings (hello, call, result, error, cancel, ping); method names are Pi Durable's.
// This file and connection.ts are the only files that know the wire.

export const PROTOCOL_VERSION = 1;
export const ENGINE = "pi-durable";

export type Hello = {
	kind: "hello";
	protocol: number;
	engine: string;
	/** Pi Durable package version the program runs; the client's own version for a client hello. */
	version: string;
	/** Absolute store directory (program hello only). */
	store?: string;
	agent?: string;
	pid: number;
	conversationId?: number;
};
export type Call = { kind: "call"; id: string; method: Method; params?: Record<string, unknown> };
export type Result = { kind: "result"; id: string; value: unknown };
export type ErrorMessage = { kind: "error"; id?: string; code: string; message: string };
export type Cancel = { kind: "cancel"; id: string };
export type Ping = { kind: "ping"; id: string };
export type Pong = { kind: "pong"; id: string };
/** One update of a watch the client opened: the view at attachment, then each commit's view and operations. */
export type View = { kind: "view"; watch: string; value: unknown; ops?: unknown };

export type Method =
	| "submit"
	| "wait"
	| "abort"
	| "compact"
	| "fork"
	| "watch"
	| "unwatch"
	| "entries"
	| "abortTask"
	| "status"
	| "drain";

export const METHODS: readonly Method[] = [
	"submit",
	"wait",
	"abort",
	"compact",
	"fork",
	"watch",
	"unwatch",
	"entries",
	"abortTask",
	"status",
	"drain",
];

export type ClientMessage = Hello | Call | Cancel | Ping;
export type ProgramMessage = Hello | Result | ErrorMessage | Pong | View;

/** Encode one message as one line. */
export function encode(message: ClientMessage | ProgramMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** Split a stream of text into lines: the feeder hands each complete non-empty line on and keeps the rest. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
	let rest = "";
	return (chunk) => {
		rest += chunk;
		let index = rest.indexOf("\n");
		while (index >= 0) {
			const line = rest.slice(0, index).trim();
			rest = rest.slice(index + 1);
			if (line.length > 0) onLine(line);
			index = rest.indexOf("\n");
		}
	};
}

export function isClientMessage(value: unknown): value is ClientMessage {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	const kind = (value as { kind: unknown }).kind;
	return kind === "hello" || kind === "call" || kind === "cancel" || kind === "ping";
}
