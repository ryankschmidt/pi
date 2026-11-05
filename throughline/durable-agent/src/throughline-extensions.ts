// ThroughLine's parts of every Pi Durable agent, in Durable form (map v3 section 4, rows 4-4 to 4-6):
//   - approvals: a beforeTool hook that asks the connected client a keyed question and waits for its answer;
//   - ThroughLine's MCP tools, one Durable tool per MCP tool, through pi-mcp, deferred behind tool_search except
//     the three T3 keeps direct;
//   - ThroughLine's orchestration instructions as one section.
// They replace T3 Code's injected coding-agent extension (packages/provider-pi/src/server/mcpExtensionSource.ts in
// the ThroughLine fork), keeping its rules: full access asks nothing, read-only tools pass, auto-accept-edits passes
// edit and write, and a declined call is blocked with "<tool> was declined in ThroughLine."


import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);
const MCP_PREFIX = "mcp__t3-code__";
const DIRECT_MCP_TOOLS = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);

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

/** The approvals hook. Read-only MCP tools come from the MCP extension's catalog. */
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
 * ThroughLine's MCP tools, listed once at start from the thread's own MCP endpoint and credential (the same
 * T3_MCP_URL and T3_MCP_BEARER_TOKEN T3 Code passes its Pi bridge). A start without them, or with the server
 * unreachable, installs an extension with no tools under the same name, so stored names still resolve.
 */
export async function createMcpExtension(
	env: NodeJS.ProcessEnv,
	log: (line: string) => void,
): Promise<{ extension: Extension; readOnly: Set<string>; close: () => Promise<void> }> {
	const readOnly = new Set<string>();
	const url = env.T3_MCP_URL;
	const token = env.T3_MCP_BEARER_TOKEN;
	const empty = { extension: defineExtension({ name: "throughline-mcp" }), readOnly, close: async () => {} };
	if (!url || !token) return empty;
	const client = new McpClient({ name: "throughline-pi-durable", version: "1.0.0" });
	try {
		await client.connect(
			new StreamableHttpTransport({
				url,
				headers: { authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` },
			}),
		);
		const catalog = await client.listTools();
		const tools = catalog.map((tool) => {
			const name = `${MCP_PREFIX}${tool.name}`;
			if (tool.annotations?.readOnlyHint === true) readOnly.add(name);
			return defineTool({
				name,
				description: tool.description ?? tool.name,
				parameters: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} } as never,
				...(DIRECT_MCP_TOOLS.has(tool.name) ? {} : { deferred: true }),
				execute: async (args: unknown) => {
					const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
					const content = toLlmContent(result);
					if (result.isError === true) {
						const text = content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
						throw new Error(text.length > 0 ? text : `MCP tool t3-code/${tool.name} returned an error`);
					}
					return { output: content, details: { server: "t3-code", tool: tool.name } };
				},
			} as never);
		});
		return {
			extension: defineExtension({ name: "throughline-mcp", tools }),
			readOnly,
			close: () => client.close(),
		};
	} catch (error) {
		log(`ThroughLine MCP unavailable at start: ${error instanceof Error ? error.message : String(error)}`);
		await client.close().catch(() => undefined);
		return empty;
	}
}

/** ThroughLine's orchestration instructions, passed by the client in T3_CODE_ORCHESTRATION_INSTRUCTIONS. */
export function createOrchestrationExtension(env: NodeJS.ProcessEnv): Extension {
	const text = env.T3_CODE_ORCHESTRATION_INSTRUCTIONS?.trim();
	return defineExtension({
		name: "throughline-orchestration",
		sections: [section("t3_code_orchestration", () => (text && text.length > 0 ? text : undefined))],
	});
}

