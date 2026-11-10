// ThroughLine's parts of every Pi Durable agent, in Durable form (map v3 section 4, rows 4-4 to 4-6):
//   - approvals: a beforeTool hook that asks the connected client a keyed question and waits for its answer;
//   - ThroughLine's tools, one Durable tool per tool ThroughLine lists, deferred behind tool_search except the three
//     T3 keeps direct; each call travels over the program's own link and ThroughLine's server makes it;
//   - ThroughLine's orchestration instructions as one section.
// They replace T3 Code's injected coding-agent extension (packages/provider-pi/src/server/mcpExtensionSource.ts in
// the ThroughLine fork), keeping its rules: full access asks nothing, read-only tools pass, auto-accept-edits passes
// edit and write, and a declined call is blocked with "<tool> was declined in ThroughLine."

import { defineExtension, defineTool, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);
/** Names the agent sees for ThroughLine's tools; ThroughLine maps them to the stock screen's names. */
export const TOOL_PREFIX = "throughline__";
const DIRECT_TOOLS = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);

export type ApprovalQuestion = {
	/** The tool call's id: stable across restarts, so a re-asked question reattaches to the same card. */
	key: string;
	tool: string;
	title: string;
	message: string;
};
export type ApprovalAnswer = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * The program's side of approvals. `ask` sends the question to the connected client and resolves when an `answer`
 * call arrives with the same key. Answers given before the question (after a restart) are kept until asked.
 */
export class Approvals {
	mode: RuntimeMode = "approval-required";
	readonly #pending = new Map<string, { question: ApprovalQuestion; resolve: (answer: ApprovalAnswer) => void }>();
	readonly #early = new Map<string, ApprovalAnswer>();
	readonly #sessionTools = new Set<string>();
	#send: ((question: ApprovalQuestion) => void) | undefined;

	connect(send: (question: ApprovalQuestion) => void): void {
		this.#send = send;
		for (const { question } of this.#pending.values()) send(question);
	}

	/** Tools the user accepted for the session; restored by the program from its stored document. */
	allowForSession(tool: string): void {
		this.#sessionTools.add(tool);
	}

	sessionTools(): string[] {
		return [...this.#sessionTools];
	}

	open(): ApprovalQuestion[] {
		return [...this.#pending.values()].map((entry) => entry.question);
	}

	needsApproval(tool: string, readOnlyMcp: ReadonlySet<string>): boolean {
		if (this.mode === "full-access") return false;
		if (READ_ONLY_TOOLS.has(tool) || readOnlyMcp.has(tool)) return false;
		if (this.mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(tool)) return false;
		return !this.#sessionTools.has(tool);
	}

	ask(question: ApprovalQuestion): Promise<ApprovalAnswer> {
		const early = this.#early.get(question.key);
		if (early !== undefined) {
			this.#early.delete(question.key);
			return Promise.resolve(early);
		}
		const existing = this.#pending.get(question.key);
		if (existing !== undefined) return new Promise((resolve) => this.#chain(question.key, resolve));
		return new Promise((resolve) => {
			this.#pending.set(question.key, { question, resolve });
			this.#send?.(question);
		});
	}

	#chain(key: string, resolve: (answer: ApprovalAnswer) => void): void {
		const entry = this.#pending.get(key);
		if (entry === undefined) return;
		const previous = entry.resolve;
		entry.resolve = (answer) => {
			previous(answer);
			resolve(answer);
		};
	}

	answer(key: string, answer: ApprovalAnswer): boolean {
		const entry = this.#pending.get(key);
		if (entry === undefined) {
			this.#early.set(key, answer);
			return false;
		}
		this.#pending.delete(key);
		if (answer === "acceptForSession") this.#sessionTools.add(entry.question.tool);
		entry.resolve(answer);
		return true;
	}
}

function summary(args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["command", "path", "file_path", "pattern", "url"]) {
			if (typeof record[key] === "string") return String(record[key]).slice(0, 2000);
		}
	}
	const text = JSON.stringify(args ?? {});
	return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** The approvals hook. ThroughLine's read-only tools come from the tool list ThroughLine handed over. */
export function createApprovalsExtension(approvals: Approvals, readOnlyMcp: ReadonlySet<string>): Extension {
	return defineExtension({
		name: "throughline-approvals",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) => {
					if (!approvals.needsApproval(call.name, readOnlyMcp)) return undefined;
					const answer = await approvals.ask({
						key: call.id,
						tool: call.name,
						title: `Allow ${call.name}?`,
						message: summary(call.arguments),
					});
					if (answer === "accept" || answer === "acceptForSession") return undefined;
					return { block: `${call.name} was declined in ThroughLine.` };
				},
			}),
		],
	});
}

/**
 * The program's side of ThroughLine's tools. A tool call leaves as a `tool` message on the program's own link
 * (stdin and stdout on the Mac) and resolves when ThroughLine answers with a `toolResult` of the same id; ThroughLine's
 * server makes the call for the thread that owns the link, so no endpoint or credential reaches the agent. Calls made
 * before a client connects (a resumed tool task) are sent on connect.
 */
export class ToolLink {
	readonly #pending = new Map<string, { message: ToolCallRequest; settle: (result: ToolCallResult) => void }>();
	#send: ((message: ToolCallRequest) => void) | undefined;
	#serial = 0;

	connect(send: (message: ToolCallRequest) => void): void {
		this.#send = send;
		for (const { message } of this.#pending.values()) send(message);
	}

	call(name: string, args: unknown): Promise<ToolCallResult> {
		const message: ToolCallRequest = { id: `tool-${++this.#serial}`, name, arguments: args ?? {} };
		return new Promise((settle) => {
			this.#pending.set(message.id, { message, settle });
			this.#send?.(message);
		});
	}

	/** ThroughLine's answer; false when no call with that id is waiting. */
	answer(id: string, result: ToolCallResult): boolean {
		const entry = this.#pending.get(id);
		if (entry === undefined) return false;
		this.#pending.delete(id);
		entry.settle(result);
		return true;
	}
}

export type ToolCallRequest = { id: string; name: string; arguments: unknown };
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolCallResult = { content: ToolContent[]; isError?: boolean };
/** One entry of the tool list ThroughLine hands the program at start (`--tools <file>`). */
export type ToolDescriptor = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	readOnly?: boolean;
};

/**
 * ThroughLine's tools as Durable tools, one per descriptor, named `throughline__<tool>` and deferred behind
 * tool_search except the three T3 keeps direct. An empty list still installs the extension under the same name, so
 * stored names resolve after a restart without the list.
 */
export function createThroughLineToolsExtension(
	descriptors: readonly ToolDescriptor[],
	link: ToolLink,
): { extension: Extension; readOnly: Set<string> } {
	const readOnly = new Set<string>();
	const tools = descriptors.map((descriptor) => {
		const name = `${TOOL_PREFIX}${descriptor.name}`;
		if (descriptor.readOnly === true) readOnly.add(name);
		const schema = descriptor.inputSchema ?? {};
		return defineTool({
			name,
			description: descriptor.description ?? descriptor.name,
			parameters: { ...schema, type: "object", properties: schema.properties ?? {} } as never,
			...(DIRECT_TOOLS.has(descriptor.name) ? {} : { deferred: true }),
			execute: async (args: unknown) => {
				const result = await link.call(descriptor.name, args);
				if (result.isError === true) {
					const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
					throw new Error(text.length > 0 ? text : `ThroughLine tool ${descriptor.name} returned an error`);
				}
				return { output: result.content, details: { tool: descriptor.name } };
			},
		} as never);
	});
	return { extension: defineExtension({ name: "throughline-tools", tools }), readOnly };
}

/** ThroughLine's orchestration instructions, passed by the client in T3_CODE_ORCHESTRATION_INSTRUCTIONS. */
export function createOrchestrationExtension(env: NodeJS.ProcessEnv): Extension {
	const text = env.T3_CODE_ORCHESTRATION_INSTRUCTIONS?.trim();
	return defineExtension({
		name: "throughline-orchestration",
		sections: [section("t3_code_orchestration", () => (text && text.length > 0 ? text : undefined))],
	});
}

