// The Pi Durable agent program: one process per agent store. It takes the store's lock, opens Pi Durable's Harness on
// SQLite, installs the same extensions every start, resumes what the last process left, and serves Pi Durable calls
// to one client as JSON lines (stdin and stdout on the Mac; the cell socket on the tower carries the same messages).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentChange,
	type Conversation,
	type ConversationId,
	type ConversationWatch,
	defineDoc,
	type EntryId,
	Harness,
	type HarnessOptions,
	type SubmissionDraft,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { lockStore, StoreAlreadyOwned, type StoreLock } from "./lock.ts";
import {
	type Call,
	ENGINE,
	encode,
	type Hello,
	isClientMessage,
	lineSplitter,
	METHODS,
	PROTOCOL_VERSION,
	type ProgramMessage,
} from "./protocol.ts";
import { attachTranscript, type TranscriptWriter } from "./transcript.ts";

export const DURABLE_VERSION: string = (() => {
	const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-durable");
	let directory = dirname(entry);
	for (let i = 0; i < 4; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			if (pkg.name === "@earendil-works/pi-durable") return String(pkg.version);
		} catch {}
		directory = dirname(directory);
	}
	return "unknown";
})();

/** Which conversation the agent's thread shows now: the root, or the newest fork after a rewind. */
type StoredBinding = { agentId: string | null; conversationId: number | null };
const Binding = defineDoc<StoredBinding>({
	kind: "throughline.agent-binding",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({ agentId: null, conversationId: null }),
});

export type ProgramOptions = {
	/** Folder holding the store, its lock and transcript.jsonl. */
	storeDir: string;
	agentId: string;
	/** What the root conversation starts with when the store is new. */
	initialAgent: AgentChange;
	harness: Omit<HarnessOptions, "onReport">;
	input: Readable;
	output: Writable;
	/** Diagnostics; never the client's channel. */
	log?: (line: string) => void;
	/** Called once the program has stopped, with its exit code. */
	onExit?: (code: number) => void;
};

export const EXIT = { ok: 0, failed: 1, alreadyOwned: 3, protocol: 4 } as const;

export async function runProgram(options: ProgramOptions): Promise<number> {
	const context: Context = BACKGROUND_CONTEXT;
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const send = (message: ProgramMessage) => {
		if (!options.output.writableEnded) options.output.write(encode(message));
	};

	let lock: StoreLock;
	try {
		lock = await lockStore(options.storeDir);
	} catch (error) {
		if (error instanceof StoreAlreadyOwned) {
			send({ kind: "error", code: error.code, message: error.message });
			return finish(EXIT.alreadyOwned);
		}
		throw error;
	}

	let harness: Harness | undefined;
	let transcript: TranscriptWriter | undefined;
	const watches = new Map<string, ConversationWatch>();
	let stopping: Promise<number> | undefined;

	function finish(code: number): number {
		options.onExit?.(code);
		return code;
	}

	async function stop(code: number): Promise<number> {
		if (stopping) return stopping;
		stopping = (async () => {
			for (const watch of watches.values()) await watch.stop().catch(() => undefined);
			watches.clear();
			transcript?.detach();
			if (harness) await harness.close(context);
			await lock.release();
			return finish(code);
		})();
		return stopping;
	}

	try {
		const storage = await openNodeSqliteStorage(join(options.storeDir, "store.sqlite"));
		harness = await Harness.open(
			storage,
			{ ...options.harness, onReport: (report) => log(`durable report: ${report.kind} ${String(report.error)}`) },
			context,
		);
		// Before root() and resume(): nothing commits between the catch-up and the observer.
		transcript = await attachTranscript(harness, join(options.storeDir, "transcript.jsonl"), context);
		const opened = harness;
		const binding = await opened.snapshot(Binding, context);
		if (binding?.agentId != null && binding.agentId !== options.agentId) {
			throw new Error(`STORE_BINDING_MISMATCH: store belongs to agent ${binding.agentId}`);
		}
		let conversation: Conversation;
		if (binding?.conversationId != null) {
			const found = await opened.conversation(binding.conversationId as ConversationId, context);
			if (found === undefined) throw new Error("BOUND_CONVERSATION_MISSING");
			conversation = found;
		} else {
			conversation = await opened.root(context, { agent: options.initialAgent });
			await bind(conversation.id);
		}
		async function bind(id: ConversationId) {
			await opened.commit(async (tx) => {
				const stored = await tx.doc(Binding);
				stored.agentId = options.agentId;
				stored.conversationId = id;
			}, context);
		}
		opened.resume();

		const hello: Hello = {
			kind: "hello",
			protocol: PROTOCOL_VERSION,
			engine: ENGINE,
			version: DURABLE_VERSION,
			store: options.storeDir,
			agent: options.agentId,
			pid: process.pid,
			conversationId: Number(conversation.id),
		};
		send(hello);

		let greeted = false;
		let watchSerial = 0;
		const handle = async (call: Call): Promise<unknown> => {
			const params = call.params ?? {};
			switch (call.method) {
				case "submit": {
					const draft = (
						params.type === "continue"
							? { type: "continue", requestId: params.requestId }
							: {
									type: "input",
									content: params.content,
									requestId: params.requestId,
									...(params.whenBusy === undefined ? {} : { whenBusy: params.whenBusy }),
									...(params.whenIdle === undefined ? {} : { whenIdle: params.whenIdle }),
								}
					) as SubmissionDraft;
					const submission = await conversation.submit(draft, context);
					return { submissionId: submission.id };
				}
				case "wait": {
					const submission = await opened.submission(params.submissionId as SubmissionId, context);
					if (submission === undefined) throw new Error("SUBMISSION_NOT_FOUND");
					return await submission.wait(context);
				}
				case "abort":
					await conversation.abort(context);
					return { aborted: true };
				case "compact":
					return {
						taskId: await conversation.compact(params.instructions as string | undefined, context),
					};
				case "fork": {
					const fork = await conversation.fork(
						params.entryId as EntryId,
						{ ownership: { kind: "ownerless" } },
						context,
					);
					conversation = fork;
					await bind(fork.id);
					return { conversationId: fork.id };
				}
				case "watch": {
					const id = `w${++watchSerial}`;
					const watch = await conversation.watch(context);
					watches.set(id, watch);
					send({ kind: "view", watch: id, value: watch.value });
					watch.start(async (update) => {
						if (update.kind === "value") send({ kind: "view", watch: id, value: update.value, ops: update.ops });
					});
					return { watch: id };
				}
				case "unwatch": {
					const watch = watches.get(String(params.watch));
					watches.delete(String(params.watch));
					await watch?.stop();
					return { stopped: watch !== undefined };
				}
				case "entries":
					return await conversation.entries(
						{ order: params.order === "descending" ? "descending" : "ascending" },
						typeof params.limit === "number" ? params.limit : 100,
						params.cursor as never,
						context,
					);
				case "abortTask":
					return { state: await opened.abortTask(params.taskId as TaskId, context) };
				case "status": {
					const inspection = await opened.inspect(context);
					return {
						wake: opened.wake(),
						conversationId: conversation.id,
						scheduling: inspection.scheduling,
						liveTasks: inspection.tasks.length,
						openSubmissions: inspection.submissions.length,
					};
				}
				case "drain":
					return { draining: true };
			}
		};

		const onLine = (line: string) => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				send({ kind: "error", code: "BAD_MESSAGE", message: "a line was not JSON" });
				return;
			}
			if (!isClientMessage(message)) {
				send({ kind: "error", code: "BAD_MESSAGE", message: "unknown message kind" });
				return;
			}
			if (message.kind === "hello") {
				if (message.protocol !== PROTOCOL_VERSION || message.engine !== ENGINE) {
					send({
						kind: "error",
						code: "PROTOCOL_MISMATCH",
						message: `program speaks ${ENGINE} protocol ${PROTOCOL_VERSION}; client sent ${message.engine} ${message.protocol}`,
					});
					void stop(EXIT.protocol);
					return;
				}
				greeted = true;
				return;
			}
			if (message.kind === "ping") {
				send({ kind: "pong", id: message.id });
				return;
			}
			if (message.kind === "cancel") {
				// Cancelling a wait never cancels the work; the client simply stops listening for that id.
				return;
			}
			if (!greeted) {
				send({ kind: "error", id: message.id, code: "HELLO_REQUIRED", message: "send hello first" });
				return;
			}
			if (!METHODS.includes(message.method)) {
				send({ kind: "error", id: message.id, code: "UNKNOWN_METHOD", message: String(message.method) });
				return;
			}
			handle(message).then(
				(value) => {
					send({ kind: "result", id: message.id, value: value ?? null });
					if (message.method === "drain") void stop(EXIT.ok);
				},
				(error: unknown) => {
					const code =
						typeof error === "object" && error !== null && "name" in error ? String(error.name) : "FAILED";
					send({ kind: "error", id: message.id, code, message: error instanceof Error ? error.message : String(error) });
				},
			);
		};

		const feed = lineSplitter(onLine);
		options.input.setEncoding("utf8");
		options.input.on("data", (chunk: string) => feed(chunk));
		// Closing the input stops the program, as closing stdin stops Pi's RPC mode.
		options.input.on("end", () => void stop(EXIT.ok));
		return await new Promise<number>((resolve) => {
			const poll = setInterval(() => {
				if (stopping) {
					clearInterval(poll);
					stopping.then(resolve, () => resolve(EXIT.failed));
				}
			}, 50);
		});
	} catch (error) {
		log(`agent program failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		send({ kind: "error", code: "PROGRAM_FAILED", message: error instanceof Error ? error.message : String(error) });
		return await stop(EXIT.failed);
	}
}
