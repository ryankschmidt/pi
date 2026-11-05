// A small client of the agent program, used by the tests and the kill proof. ThroughLine's Durable client (build 2)
// speaks the same messages from the ThroughLine fork.

import { type ChildProcess, spawn } from "node:child_process";
import {
	type Call,
	ENGINE,
	encode,
	type Hello,
	lineSplitter,
	type Method,
	PROTOCOL_VERSION,
	type ProgramMessage,
	type Question,
	type View,
} from "./protocol.ts";

export class ProgramError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

export type AgentProgram = {
	readonly child: ChildProcess;
	/** The program's hello, or its first error when it refused to start. */
	readonly hello: Promise<Hello>;
	readonly exited: Promise<number | null>;
	readonly stderr: () => string;
	call(method: Method, params?: Record<string, unknown>): Promise<unknown>;
	onView(listener: (view: View) => void): void;
	onQuestion(listener: (question: Question["question"]) => void): void;
	/** Kill outright: no cleanup, as a crash or power cut would leave it. */
	kill(): void;
};

export function startProgram(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; protocol?: number } = {},
): AgentProgram {
	const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	let serial = 0;
	let errors = "";
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const listeners: ((view: View) => void)[] = [];
	const questionListeners: ((question: Question["question"]) => void)[] = [];
	let settleHello: { resolve: (hello: Hello) => void; reject: (error: Error) => void } | undefined;
	const hello = new Promise<Hello>((resolve, reject) => {
		settleHello = { resolve, reject };
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		errors += chunk;
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	exited.then((code) => {
		settleHello?.reject(new ProgramError("EXITED", `program exited ${code} before hello`));
		for (const waiter of pending.values()) waiter.reject(new ProgramError("EXITED", `program exited ${code}`));
		pending.clear();
	});
	child.stdout?.setEncoding("utf8");
	child.stdout?.on(
		"data",
		lineSplitter((line) => {
			const message = JSON.parse(line) as ProgramMessage;
			if (message.kind === "hello") {
				settleHello?.resolve(message);
				settleHello = undefined;
				child.stdin?.write(
					encode({
						kind: "hello",
						protocol: options.protocol ?? PROTOCOL_VERSION,
						engine: ENGINE,
						version: "test-client",
						pid: process.pid,
					}),
				);
			} else if (message.kind === "result") {
				pending.get(message.id)?.resolve(message.value);
				pending.delete(message.id);
			} else if (message.kind === "error") {
				const error = new ProgramError(message.code, message.message);
				if (message.id !== undefined && pending.has(message.id)) {
					pending.get(message.id)?.reject(error);
					pending.delete(message.id);
				} else if (settleHello) {
					settleHello.reject(error);
					settleHello = undefined;
				}
			} else if (message.kind === "view") {
				for (const listener of listeners) listener(message);
			} else if (message.kind === "question") {
				for (const listener of questionListeners) listener(message.question);
			}
		}),
	);
	child.stdin?.on("error", () => undefined);
	return {
		child,
		hello,
		exited,
		stderr: () => errors,
		call(method, params) {
			const id = `c${++serial}`;
			const call: Call = { kind: "call", id, method, ...(params === undefined ? {} : { params }) };
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				child.stdin?.write(encode(call));
			});
		},
		onView(listener) {
			listeners.push(listener);
		},
		onQuestion(listener) {
			questionListeners.push(listener);
		},
		kill() {
			child.kill("SIGKILL");
		},
	};
}
