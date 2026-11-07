// The Pi-extension bridge: runs Ryan's installed Pi agent extensions (<agent dir>/extensions, the files stock Pi
// threads load) inside a Pi Durable agent, so a Pi extension is written once and reaches both kinds of thread.
//
// Each file is loaded by Pi's own loader (coding-agent dist, the same library reuse as setup.ts), then every part it
// registered is mapped onto the Durable harness:
//   tool_call                 -> ToolTask.beforeTool         (block -> { block }, in-place input edits -> { arguments })
//   tool_result               -> ToolTask.afterTool          (content, details, isError replace the result)
//   context                   -> GenerationTask.beforeRequest
//   before_provider_request   -> GenerationTask.beforeProviderRequest
//   message_end               -> GenerationTask.afterResponse (assistant messages only)
//   turn_end                  -> GenerationTask.afterTools and onYield
//   agent_end                 -> GenerationTask.afterRun
//   session_before_compact    -> CompactionTask.beforeCompact (cancel -> { decline }, compaction.summary -> { summary })
//   session_start             -> once per conversation, before that conversation's first bridged hook
//   registerTool              -> a Durable tool
//   registerCommand           -> listed, and runnable through `runCommand`
// Everything else an extension registers, and every context member or action it uses that has no Durable meaning, is
// written to the extension's report as unmapped and logged at start or on first use. Nothing is dropped silently and
// nothing is faked: `ctx.ui` is Pi's own no-UI behaviour (calls are recorded, nothing is drawn), and there is no Pi
// session file on a Durable thread; the lead-boundary hook gets the actual Durable agent identifier and transcript
// projection rather than a made-up stock-Pi session file.
//
// Replay: Durable hooks run inside checkpointed tasks and may run again after a crash. The two verdict hooks that can
// carry a JEV or model call (tool_call and session_before_compact) store their verdict as a task memo per extension,
// so a restarted task reuses the verdict and does not run the extension's check again.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "../../../packages/coding-agent/dist/config.js";
import { expandPromptTemplate, loadPromptTemplates } from "../../../packages/coding-agent/dist/core/prompt-templates.js";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	CompactionTask,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	type HookApi,
	type HookRegistration,
	hook,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolHookCall,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createExtensionRuntime, loadExtensions } from "../../../packages/coding-agent/dist/core/extensions/loader.js";
import type {
	Extension as PiExtension,
	ExtensionRuntime,
} from "../../../packages/coding-agent/dist/core/extensions/types.js";

/** One part of a Pi extension the bridge carried onto the Durable harness. */
export type MappedPart = {
	kind: "event" | "tool" | "command";
	name: string;
	onto: string;
	fidelity: "full" | "partial";
	note?: string;
};

/** One part of a Pi extension that has no Durable equivalent yet, and why. */
export type UnmappedPart = {
	kind: "event" | "registration" | "ctx" | "action";
	name: string;
	reason: string;
};

/** What the bridge did with one Pi extension file. */
export type ExtensionReport = {
	/** Durable extension name; stored conversations resolve it after every restart. */
	name: string;
	path: string;
	status: "loaded" | "failed";
	error?: string;
	mapped: MappedPart[];
	unmapped: UnmappedPart[];
};

/** A slash command a bridged extension registered. */
export type BridgedCommand = { extension: string; name: string; description?: string };

/** The bridge's output: one Durable extension per Pi extension file, its report, and the commands found. */
export type PiExtensionBridge = {
	extensions: Extension[];
	reports: ExtensionReport[];
	commands: BridgedCommand[];
	/** Runs a bridged command's handler with the bridge's context; false when no extension registered `name`. */
	runCommand(name: string, args: string, cwd: string): Promise<boolean>;
	/** Tool names the bridged extensions declared read-only through `READ_ONLY_BRIDGED_TOOLS`. */
	readOnly: Set<string>;
	/** Expand discovered Pi prompt templates in a user submission, preserving non-text inputs. */
	expandInput(input: unknown): unknown;
};

export type BridgeOptions = {
	/** Directory extensions see as `ctx.cwd` when a hook has no execution environment. */
	cwd: string;
	/** Context window of a model, for `ctx.getContextUsage()`. */
	contextWindow?: (provider: string, modelId: string) => number | undefined;
	/** Where start-time and first-use lines go (the program's stderr). */
	log?: (line: string) => void;
	/** The actual Durable agent identifier and projected transcript, not a fabricated stock-Pi session. */
	agentId?: string;
	transcriptPath?: string;
};

/** Prefix of every bridged Durable extension name. */
export const BRIDGE_PREFIX = "pi-extension:";

/**
 * The extension files stock Pi discovers for `cwd`: `<cwd>/.pi/extensions` first, then `<agent dir>/extensions`, each a
 * `.ts` or `.js` file or a folder with an `index.ts` or `index.js`. Package manifests and configured paths are not
 * read yet (stock Pi reads both).
 */
export function discoverPiExtensions(cwd: string, agentDir: string): string[] {
	const found: string[] = [];
	for (const dir of [join(cwd, ".pi", "extensions"), join(agentDir, "extensions")]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			// The installed rtk is intentionally excluded from Durable agents.
			if (dir === join(agentDir, "extensions") && name === "rtk.ts") continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				const index = ["index.ts", "index.js"].map((file) => join(full, file)).find((file) => existsSync(file));
				if (index !== undefined) found.push(index);
			} else if (name.endsWith(".ts") || name.endsWith(".js")) {
				found.push(full);
			}
		}
	}
	return found;
}

/** Loads each file with Pi's loader and builds its Durable extension and report. */
export async function bridgePiExtensions(paths: readonly string[], options: BridgeOptions): Promise<PiExtensionBridge> {
	const state = new BridgeState(options);
	const extensions: Extension[] = [];
	const reports: ExtensionReport[] = [];
	const commands: BridgedCommand[] = [];
	const readOnly = new Set<string>();
	const handlersByCommand = new Map<string, { report: ExtensionReport; handler: CommandHandler }>();
	const promptPaths: string[] = [];
	for (const path of paths) {
		const report: ExtensionReport = { name: extensionName(path), path, status: "loaded", mapped: [], unmapped: [] };
		reports.push(report);
		const runtime = createExtensionRuntime();
		recordActions(runtime, report, state);
		const loaded = await loadExtensions([path], options.cwd, undefined, runtime);
		const pi = loaded.extensions[0];
		if (pi === undefined) {
			report.status = "failed";
			report.error = loaded.errors[0]?.error ?? "the loader returned no extension";
			extensions.push(defineExtension({ name: report.name }));
			continue;
		}
		extensions.push(bridgeOne(pi, report, state));
		for (const handler of (pi.handlers.get("resources_discover") ?? []) as Handler[]) {
			const result = await state.guard(report, "resources_discover", () => handler(
				{ type: "resources_discover", cwd: options.cwd, reason: "startup" },
				state.ctx(report, undefined, options.cwd, undefined),
			)) as { promptPaths?: string[]; skillPaths?: string[]; themePaths?: string[] } | undefined;
			if (result?.promptPaths) promptPaths.push(...result.promptPaths);
			if (result?.skillPaths?.length || result?.themePaths?.length) state.unmapped(report, "event", "resources_discover skillPaths/themePaths", "only prompt paths are currently carried");
		}
		for (const tool of pi.tools.keys()) if (READ_ONLY_BRIDGED_TOOLS.has(tool)) readOnly.add(tool);
		for (const [name, command] of pi.commands) {
			commands.push({ extension: report.name, name, ...(command.description ? { description: command.description } : {}) });
			handlersByCommand.set(name, { report, handler: command.handler as CommandHandler });
		}
	}
	const templates = loadPromptTemplates({ cwd: options.cwd, agentDir: getAgentDir(), promptPaths, includeDefaults: false });
	for (const diagnostic of templates.diagnostics) options.log?.(`Pi prompt template: ${diagnostic.message}`);
	for (const report of reports) options.log?.(describeReport(report));
	return {
		extensions,
		reports,
		commands,
		readOnly,
		expandInput: (input) => {
			if (typeof input === "string") return expandPromptTemplate(input, templates.templates);
			if (!Array.isArray(input) || input[0]?.type !== "text" || typeof input[0]?.text !== "string") return input;
			return [{ ...input[0], text: expandPromptTemplate(input[0].text, templates.templates) }, ...input.slice(1)];
		},
		runCommand: async (name, args, cwd) => {
			const entry = handlersByCommand.get(name);
			if (entry === undefined) return false;
			await entry.handler(args, state.ctx(entry.report, undefined, cwd, undefined));
			return true;
		},
	};
}

/** One line per extension: what was mapped and what was not. */
export function describeReport(report: ExtensionReport): string {
	if (report.status === "failed") return `${report.name}: not bridged; ${report.error}`;
	const mapped = report.mapped.map((part) => `${part.name}->${part.onto}${part.fidelity === "partial" ? "(partial)" : ""}`);
	const unmapped = report.unmapped.map((part) => `${part.name} (${part.reason})`);
	return `${report.name}: mapped ${mapped.join(", ") || "nothing"}; unmapped ${unmapped.join("; ") || "nothing"}`;
}

/** Tools from bridged extensions that only read, so ThroughLine's approvals pass them as they pass `read`. */
const READ_ONLY_BRIDGED_TOOLS = new Set(["inspect_image"]);

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function extensionName(path: string): string {
	const file = basename(path);
	const stem = file === "index.ts" || file === "index.js" ? basename(join(path, "..")) : file.replace(/\.(ts|js)$/, "");
	return `${BRIDGE_PREFIX}${stem}`;
}

/** How each Pi event is carried; events not listed here are reported unmapped with `UNMAPPED_EVENTS` or a default. */
const EVENT_MAP: Record<string, Omit<MappedPart, "kind" | "name">> = {
	resources_discover: { onto: "Pi prompt templates at submit", fidelity: "partial", note: "prompt paths only; no dynamic reload" },
	tool_call: { onto: "ToolTask.beforeTool", fidelity: "full", note: "block -> { block }; in-place input edits -> { arguments }; verdict memoized per call" },
	tool_result: { onto: "ToolTask.afterTool", fidelity: "full", note: "content, details and isError replace the result" },
	context: { onto: "GenerationTask.beforeRequest", fidelity: "full" },
	before_provider_request: { onto: "GenerationTask.beforeProviderRequest", fidelity: "full" },
	message_end: {
		onto: "GenerationTask.afterResponse",
		fidelity: "partial",
		note: "assistant messages only; a replacement message is not applied",
	},
	turn_end: {
		onto: "GenerationTask.afterTools+onYield",
		fidelity: "partial",
		note: "custom messages continue at yield; custom markers are carried in history; turn index counts per process",
	},
	agent_end: {
		onto: "GenerationTask.afterRun",
		fidelity: "partial",
		note: "after an answered run, not after a failure or an abort",
	},
	session_before_compact: {
		onto: "CompactionTask.beforeCompact",
		fidelity: "partial",
		note: "cancel -> { decline }, compaction.summary -> { summary }; Durable keeps its own first kept entry; verdict memoized",
	},
	session_start: {
		onto: "first bridged hook of each conversation",
		fidelity: "partial",
		note: "reason 'startup', once per conversation per process",
	},
};

/** Why named Pi events have no Durable hook. */
const UNMAPPED_EVENTS: Record<string, string> = {
	session_compact: "Durable has no after-compaction hook",
	before_agent_start: "replaces the whole system prompt; Durable builds the prompt from sections (not mapped yet)",
	session_shutdown: "a Durable agent has no per-session shutdown; the program drains instead",
};

const UNMAPPED_REGISTRATIONS: Record<string, string> = {
	messageRenderers: "terminal UI only",
	entryRenderers: "terminal UI only",
	toolRenderers: "terminal UI only",
	markdownTransformer: "terminal UI only",
	flags: "Pi command-line flags; the program takes no extension flags",
	shortcuts: "terminal keyboard only",
};

function bridgeOne(pi: PiExtension, report: ExtensionReport, state: BridgeState): Extension {
	const handlers = (event: string): Handler[] => (pi.handlers.get(event) ?? []) as Handler[];
	for (const event of pi.handlers.keys()) {
		const mapped = EVENT_MAP[event];
		if (mapped !== undefined) report.mapped.push({ kind: "event", name: event, ...mapped });
		else report.unmapped.push({ kind: "event", name: event, reason: UNMAPPED_EVENTS[event] ?? "no Durable hook" });
	}
	for (const [key, reason] of Object.entries(UNMAPPED_REGISTRATIONS)) {
		const value = (pi as unknown as Record<string, unknown>)[key];
		const count = value instanceof Map ? value.size : Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
		if (count > 0) report.unmapped.push({ kind: "registration", name: key, reason });
	}
	const tools = [...pi.tools.values()].map((registered) => {
		report.mapped.push({ kind: "tool", name: registered.definition.name, onto: "Durable tool", fidelity: "full" });
		return bridgeTool(registered.definition as unknown as PiTool, report, state);
	});
	for (const name of pi.commands.keys()) {
		report.mapped.push({
			kind: "command",
			name,
			onto: "PiExtensionBridge.commands",
			fidelity: "partial",
			note: "listed and runnable; not yet in the protocol hello",
		});
	}
	const hooks: HookRegistration[] = [];
	const toolHooks = toolTaskHooks(handlers, report, state);
	if (toolHooks !== undefined) hooks.push(hook(ToolTask, toolHooks));
	const generationHooks = pi.handlers.size === 0 ? undefined : generationTaskHooks(handlers, report, state);
	if (generationHooks !== undefined) hooks.push(hook(GenerationTask, generationHooks));
	if (handlers("session_before_compact").length > 0) {
		hooks.push(hook(CompactionTask, { beforeCompact: beforeCompact(handlers, report, state) }));
	}
	return defineExtension({ name: report.name, tools, hooks });
}

/** A tool as a Pi extension hands it to `pi.registerTool`. */
type PiTool = {
	name: string;
	description: string;
	parameters: object;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: ToolExecutionResult["output"]; details?: unknown; isError?: boolean }>;
};

function bridgeTool(tool: PiTool, report: ExtensionReport, state: BridgeState) {
	return defineTool({
		name: tool.name,
		description: tool.description,
		// TypeBox schemas carry symbol keys; the JSON form is the schema the model and the validator need.
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as object,
		execute: async (args: unknown, api: ToolExecutionApi, context: Context) => {
			const cwd = api.env?.cwd ?? state.cwd;
			const result = await tool.execute(api.callId, args, context.abortSignal, undefined, state.ctx(report, undefined, cwd, context));
			return {
				output: result.content,
				details: jsonSafe(result.details ?? { tool: tool.name }),
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	} as never);
}

type ToolVerdict = { block?: string; arguments?: Record<string, JsonValue> };

function toolTaskHooks(handlers: (event: string) => Handler[], report: ExtensionReport, state: BridgeState) {
	const calls = handlers("tool_call");
	const results = handlers("tool_result");
	if (calls.length === 0 && results.length === 0) return undefined;
	return {
		...(calls.length === 0
			? {}
			: {
					beforeTool: async (call: ToolHookCall, api: HookApi, context: Context) => {
						await state.start(report, handlers, api, context);
						if (basename(report.path) === "boundary-gate.js" && !["read", "grep", "find", "ls"].includes(call.name)) {
							const hold = await boundaryHoldFromHistory(api, context, state.cwd);
							if (hold) return { block: "boundary-gate hold: post-boundary onboarding is reading, never writing. Read the handoff files and provide the RE-ENTRY and INTENT ONBOARDED lines before changing anything. This preserves the pre-boundary context; skipping it risks edits made without the decisions and unfinished work in the handoff." };
							// The installed gate's in-memory hold belongs to the last conversation that
							// compacted, not necessarily this one. The committed history above is the
							// authority for the held-tool decision, including after a fork or restart.
							return undefined;
						}
						const memo = `${report.name}:tool_call`;
						const prior = await api.memo<ToolVerdict>(memo, context);
						const verdict = prior ?? (await api.memo(memo, await runToolCall(calls, call, report, state, api, context), context));
						if (verdict.block !== undefined) return { block: verdict.block };
						return verdict.arguments === undefined ? undefined : { arguments: verdict.arguments };
					},
				}),
		...(results.length === 0
			? {}
			: {
					afterTool: async (call: ToolHookCall, result: ToolExecutionResult, api: HookApi, context: Context) => {
						await state.start(report, handlers, api, context);
						return runToolResult(results, call, result, report, state, api, context);
					},
				}),
	};
}

/** Rebuild the boundary hold from committed, fork-aware Durable history, not process memory. */
export async function boundaryHoldFromHistory(api: HookApi, context: Context, cwd = process.cwd()): Promise<boolean> {
	const entries: Awaited<ReturnType<HookApi["entries"]>>["items"][number][] = [];
	let cursor: Parameters<HookApi["entries"]>[2];
	do {
		const page = await api.entries({ order: "ascending" }, 500, cursor, context);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const textOf = (message: { content?: unknown }): string => typeof message.content === "string" ? message.content :
		Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n") : "";
	let active = false;
	let listed: string[] = [];
	let target: string | undefined;
	const reads = new Set<string>();
	const pendingReads = new Map<string, string>();
	for (const entry of entries) {
		if (entry.kind === "pi.reset") { active = false; continue; }
		for (const message of entry.model ?? []) {
			const text = textOf(message);
			if (entry.kind === "pi.compaction" && text.includes("CONTEXT BOUNDARY — this summary is a handoff")) {
				active = true; reads.clear(); pendingReads.clear();
				const kickoff = text.split("----- HANDOFF -----")[1] ?? "";
				listed = (kickoff.match(/\/(?:Users|home|srv|opt|private|tmp)\/[^\s`'"<>|]+/g) ?? []).map((p) => p.replace(/….*$/, "").replace(/#.*$/, "").replace(/[.,;:)\]]+$/, ""));
				target = text.match(/full target id ([^\s.]+)/)?.[1];
				continue;
			}
			if (!active) continue;
			if (message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall" && part.name === "read" && typeof part.arguments.path === "string") pendingReads.set(part.id, resolve(cwd, part.arguments.path));
				if (text.includes("RE-ENTRY ") && text.includes("INTENT ONBOARDED:") && (!target || text.includes(target)) && (listed.length === 0 || listed.some((path) => reads.has(path)))) active = false;
			} else if (message.role === "toolResult" && !message.isError) {
				const path = pendingReads.get(message.toolCallId);
				if (path) reads.add(path);
			}
		}
	}
	return active;
}

async function runToolCall(
	calls: Handler[],
	call: ToolHookCall,
	report: ExtensionReport,
	state: BridgeState,
	api: HookApi,
	context: Context,
): Promise<ToolVerdict> {
	const ctx = state.ctx(report, api, undefined, context);
	const input = structuredClone((call.arguments ?? {}) as Record<string, JsonValue>);
	const before = JSON.stringify(input);
	const event = { type: "tool_call", toolCallId: call.id, toolName: call.name, input };
	// Pi does not catch tool_call errors, and a Durable beforeTool throw blocks: both block the call.
	for (const handler of calls) {
		const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
		if (result?.block === true) return { block: result.reason ?? `${call.name} was blocked by ${report.path}` };
	}
	return JSON.stringify(event.input) === before ? {} : { arguments: event.input };
}

async function runToolResult(
	results: Handler[],
	call: ToolHookCall,
	result: ToolExecutionResult,
	report: ExtensionReport,
	state: BridgeState,
	api: HookApi,
	context: Context,
): Promise<ToolExecutionResult | undefined> {
	const ctx = state.ctx(report, api, undefined, context);
	const event = {
		type: "tool_result",
		toolCallId: call.id,
		toolName: call.name,
		input: call.arguments ?? {},
		content: result.output ?? [],
		details: result.details,
		isError: result.isError === true,
	};
	let modified = false;
	for (const handler of results) {
		const change = await state.guard(report, "tool_result", () => handler(event, ctx));
		const typed = change as { content?: ToolExecutionResult["output"]; details?: unknown; isError?: boolean } | undefined;
		if (typed?.content !== undefined) event.content = typed.content;
		if (typed?.details !== undefined) event.details = jsonSafe(typed.details);
		if (typed?.isError !== undefined) event.isError = typed.isError;
		modified ||= typed !== undefined && (typed.content !== undefined || typed.details !== undefined || typed.isError !== undefined);
	}
	if (!modified) return undefined;
	return { ...result, output: event.content, details: event.details, isError: event.isError };
}

function generationTaskHooks(handlers: (event: string) => Handler[], report: ExtensionReport, state: BridgeState) {
	const context = handlers("context");
	const provider = handlers("before_provider_request");
	const messageEnd = handlers("message_end");
	const turnEnd = handlers("turn_end");
	const agentEnd = handlers("agent_end");
	const turns = { index: 0 };
	const fireTurnEnd = async (message: unknown, toolResults: unknown[], api: HookApi, ctx: Context) => {
		// A Durable turn that reaches these hooks completed; Pi's boundary fields start empty, as on a stock turn.
		const event = { type: "turn_end", turnIndex: turns.index++, message, toolResults, outcome: "completed", entries: [], continue: false };
		const branch: { type: string; customType: string }[] = [];
		let cursor: Parameters<HookApi["entries"]>[2];
		do {
			const page = await api.entries({ order: "ascending" }, 500, cursor, ctx);
			for (const entry of page.items) for (const m of entry.model ?? []) {
				if (m.role !== "user") continue;
				const text = typeof m.content === "string" ? m.content : m.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				for (const match of text.matchAll(/^\[pi-extension-entry:([^\]\n]+)\]$/gm)) branch.push({ type: "custom", customType: match[1]! });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		for (const handler of turnEnd) {
			const result = await state.guard(report, "turn_end", () => handler(event, state.ctx(report, api, undefined, ctx, branch))) as
				{ continue?: boolean; entries?: { type?: string; customType?: string; content?: unknown }[] } | undefined;
			if (!result?.continue || !result.entries) continue;
			const markers = result.entries.filter((entry) => entry.type === "custom" && typeof entry.customType === "string").map((entry) => `[pi-extension-entry:${entry.customType}]`);
			const messages = result.entries.filter((entry) => entry.type === "custom_message" && typeof entry.content === "string").map((entry) => entry.content as string);
			if (messages.length > 0) {
				const identityNote = basename(report.path) === "pi-lead-boundary.js"
					? "This is a Pi Durable agent. The identifier below is its Durable agent identifier, and the transcript is a Durable projection, not a stock Pi session file. The handoff command may not recognize that format; report a refusal honestly rather than substituting another session."
					: undefined;
				return [...markers, ...(identityNote ? [identityNote] : []), ...messages].join("\n\n");
			}
		}
		return undefined;
	};
	return {
		beforeRequest: async (request: { readonly messages: readonly unknown[] }, api: HookApi, ctx: Context) => {
			await state.start(report, handlers, api, ctx);
			if (context.length === 0) return undefined;
			let messages = structuredClone([...request.messages]);
			let modified = false;
			for (const handler of context) {
				const event = { type: "context", messages };
				const result = (await state.guard(report, "context", () => handler(event, state.ctx(report, api, undefined, ctx)))) as
					| { messages?: unknown[] }
					| undefined;
				if (result?.messages !== undefined) {
					messages = result.messages;
					modified = true;
				}
			}
			return modified ? ({ messages } as never) : undefined;
		},
		...(provider.length === 0
			? {}
			: {
					beforeProviderRequest: async (request: { readonly payload: unknown }, api: HookApi, ctx: Context) => {
						let payload = request.payload;
						for (const handler of provider) {
							const event = { type: "before_provider_request", payload };
							const result = await state.guard(report, "before_provider_request", () => handler(event, state.ctx(report, api, undefined, ctx)));
							if (result !== undefined) payload = result;
						}
						return payload === request.payload ? undefined : { payload };
					},
				}),
		afterResponse: async (message: { usage?: unknown; provider?: string; model?: string }, api: HookApi, ctx: Context) => {
			state.observeUsage(String(api.conversationId), message);
			for (const handler of messageEnd) {
				const result = (await state.guard(report, "message_end", () =>
					handler({ type: "message_end", message }, state.ctx(report, api, undefined, ctx)),
				)) as { message?: unknown } | undefined;
				if (result?.message !== undefined) {
					state.unmapped(report, "event", "message_end result", "Durable afterResponse cannot replace a message; not applied");
				}
			}
		},
		...(turnEnd.length === 0
			? {}
			: {
					afterTools: async (assistant: unknown, results: readonly unknown[], api: HookApi, ctx: Context) => {
						const message = await modelMessage(api, assistant, ctx);
						const toolResults = await Promise.all(results.map((id) => modelMessage(api, id, ctx)));
						await fireTurnEnd(message, toolResults, api, ctx);
					},
					onYield: async (answer: unknown, api: HookApi, ctx: Context) => {
						const continuation = await fireTurnEnd(answer, [], api, ctx);
						return continuation === undefined ? undefined : { continue: continuation };
					},
				}),
		...(agentEnd.length === 0
			? {}
			: {
					afterRun: async (run: { first: unknown; last: unknown }, api: HookApi, ctx: Context) => {
						const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as never, 500, undefined, ctx);
						const messages = page.items.flatMap((entry) => [...(entry.model ?? [])]);
						for (const handler of agentEnd) {
							await state.guard(report, "agent_end", () => handler({ type: "agent_end", messages }, state.ctx(report, api, undefined, ctx)));
						}
						return undefined;
					},
				}),
	};
}

async function modelMessage(api: HookApi, id: unknown, context: Context): Promise<unknown> {
	const entry = await api.entry(id as never, context);
	return entry?.model?.[0];
}

type CompactVerdict = { decline?: true; summary?: string };

function beforeCompact(handlers: (event: string) => Handler[], report: ExtensionReport, state: BridgeState) {
	return async (
		compaction: {
			readonly reason: "manual" | "threshold" | "overflow";
			readonly messages: readonly unknown[];
			readonly firstKept: unknown;
			readonly instructions?: string;
		},
		api: HookApi,
		context: Context,
	) => {
		await state.start(report, handlers, api, context);
		const memo = `${report.name}:session_before_compact`;
		const prior = await api.memo<CompactVerdict>(memo, context);
		const verdict = prior ?? (await api.memo(memo, await runBeforeCompact(handlers, compaction, report, state, api, context), context));
		if (verdict.decline === true) return { decline: true as const };
		return verdict.summary === undefined ? undefined : { summary: verdict.summary };
	};
}

async function runBeforeCompact(
	handlers: (event: string) => Handler[],
	compaction: {
		readonly reason: "manual" | "threshold" | "overflow";
		readonly messages: readonly unknown[];
		readonly firstKept: unknown;
		readonly instructions?: string;
	},
	report: ExtensionReport,
	state: BridgeState,
	api: HookApi,
	context: Context,
): Promise<CompactVerdict> {
	const event = {
		type: "session_before_compact",
		reason: compaction.reason,
		willRetry: false,
		signal: context.abortSignal,
		branchEntries: compaction.messages.map((message) => ({ type: "message", message })),
		preparation: {
			firstKeptEntryId: String(compaction.firstKept),
			tokensBefore: state.usage(String(api.conversationId))?.tokens ?? 0,
		},
		...(compaction.instructions === undefined ? {} : { customInstructions: compaction.instructions }),
	};
	for (const handler of handlers("session_before_compact")) {
		const result = (await state.guard(report, "session_before_compact", () =>
			handler(event, state.ctx(report, api, undefined, context)),
		)) as { cancel?: boolean; compaction?: { summary?: string } } | undefined;
		if (result?.cancel === true) return { decline: true };
		if (typeof result?.compaction?.summary === "string") return { summary: result.compaction.summary };
	}
	return {};
}

/** Pi's action methods with no Durable equivalent; a call is recorded on the extension's report and logged once. */
const RECORDED_ACTIONS = [
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"setSessionName",
	"getSessionName",
	"setLabel",
	"getActiveTools",
	"getAllTools",
	"getSettings",
	"setActiveTools",
	"getCommands",
	"setModel",
	"getThinkingLevel",
	"setThinkingLevel",
] as const;

function recordActions(runtime: ExtensionRuntime, report: ExtensionReport, state: BridgeState): void {
	const target = runtime as unknown as Record<string, unknown>;
	for (const action of RECORDED_ACTIONS) {
		target[action] = (...args: unknown[]) => {
			state.unmapped(report, "action", `pi.${action}`, "no Durable equivalent wired yet; the call did nothing", args[0]);
			return action === "setModel" ? Promise.resolve(false) : undefined;
		};
	}
}

function jsonSafe(value: unknown): JsonValue {
	return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

type Usage = { tokens: number; contextWindow: number };

/** Per-process state the bridge's hooks share: started conversations, last usage, and first-use logging. */
class BridgeState {
	readonly cwd: string;
	readonly #options: BridgeOptions;
	readonly #started = new Set<string>();
	readonly #usage = new Map<string, Usage>();
	readonly #logged = new Set<string>();

	constructor(options: BridgeOptions) {
		this.#options = options;
		this.cwd = options.cwd;
	}

	/** Fires session_start once per extension and conversation, before that conversation's first bridged hook. */
	async start(report: ExtensionReport, handlers: (event: string) => Handler[], api: HookApi, context: Context): Promise<void> {
		const key = `${report.name}\u0000${api.conversationId}`;
		if (this.#started.has(key)) return;
		this.#started.add(key);
		for (const handler of handlers("session_start")) {
			await this.guard(report, "session_start", () =>
				handler({ type: "session_start", reason: "startup" }, this.ctx(report, api, undefined, context)),
			);
		}
	}

	observeUsage(conversationId: string, message: { usage?: unknown; provider?: string; model?: string }): void {
		const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
		if (usage === undefined) return;
		const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const window =
			message.provider && message.model ? this.#options.contextWindow?.(message.provider, message.model) : undefined;
		this.#usage.set(conversationId, { tokens, contextWindow: window ?? 0 });
	}

	usage(conversationId: string): Usage | undefined {
		return this.#usage.get(conversationId);
	}

	/** Runs one handler; an error is recorded and logged, as Pi's runner reports extension errors and goes on. */
	async guard(report: ExtensionReport, event: string, run: () => unknown): Promise<unknown> {
		try {
			return await run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#once(`${report.name}:error:${event}:${message}`, `${report.name}: ${event} handler failed: ${message}`);
			return undefined;
		}
	}

	/** Records an unmapped part used at run time on the report, and logs it the first time. */
	unmapped(report: ExtensionReport, kind: UnmappedPart["kind"], name: string, reason: string, detail?: unknown): void {
		if (!report.unmapped.some((part) => part.kind === kind && part.name === name)) {
			report.unmapped.push({ kind, name, reason });
		}
		const shown = detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`;
		this.#once(`${report.name}:${kind}:${name}`, `${report.name}: ${name} unmapped on Durable (${reason})${shown}`);
	}

	/**
	 * Pi's ExtensionContext for one call. Members with a Durable meaning answer; any other member is recorded unmapped
	 * and answers undefined.
	 */
	ctx(report: ExtensionReport, api: HookApi | undefined, cwd: string | undefined, context: Context | undefined, branch?: unknown[]): unknown {
		const conversationId = api === undefined ? undefined : String(api.conversationId);
		const ui = recorder(this, report, "ctx.ui", "Pi's no-UI mode: nothing is drawn on a Durable thread");
		const leadContext = basename(report.path) === "pi-lead-boundary.js" && branch !== undefined;
		const sessionManager = {
			getSessionId: () => leadContext ? this.#options.agentId : undefined,
			getSessionFile: () => leadContext ? this.#options.transcriptPath : undefined,
			getBranch: () => branch ?? [],
		};
		const base: Record<string, unknown> = {
			cwd: cwd ?? this.cwd,
			hasUI: false,
			ui,
			sessionManager,
			signal: context?.abortSignal,
			isIdle: () => false,
			getContextUsage: () => {
				const usage = conversationId === undefined ? undefined : this.#usage.get(conversationId);
				if (usage === undefined) return undefined;
				const percent = usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : null;
				return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent };
			},
		};
		return new Proxy(base, {
			get: (target, key) => {
				if (typeof key !== "string" || key in target) return target[key as string];
				this.unmapped(report, "ctx", `ctx.${key}`, "no Durable equivalent wired yet");
				return undefined;
			},
		});
	}

	#once(key: string, line: string): void {
		if (this.#logged.has(key)) return;
		this.#logged.add(key);
		this.#options.log?.(line);
	}
}

/** An object whose every method records its use as unmapped and returns undefined. */
function recorder(state: BridgeState, report: ExtensionReport, prefix: string, reason: string): unknown {
	return new Proxy(
		{},
		{
			get: (_target, key) => (...args: unknown[]) => {
				state.unmapped(report, "ctx", `${prefix}.${String(key)}`, reason, args.length > 0 ? args : undefined);
				return undefined;
			},
		},
	);
}
