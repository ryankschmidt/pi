#!/usr/bin/env node
// Command line of the Pi Durable agent program.
//   node src/main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]
//                    [--carry-from <stock Pi session file>]
// Models, logins, settings and skills come from pi's agent folder (PI_CODING_AGENT_DIR, default ~/.pi/agent).
// ThroughLine sends the list of its tools in `configure` (stored with the session) and its orchestration instructions
// (T3_CODE_ORCHESTRATION_INSTRUCTIONS) in the environment. Tool calls go back to ThroughLine over stdin and stdout;
// no MCP endpoint or credential is passed to the agent.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { withPinnedClaudeCodeVersion } from "./claude-code-version.ts";
import { claudeStandardPromptAtStart } from "./claude-standard-prompt.ts";
import { SEARCH_HISTORY_TOOL } from "./history.ts";
import { createHistoryExtension } from "./history-tool.ts";
import { configureHttp } from "./http.ts";
import { loadImageTools, READ_ONLY_IMAGE_TOOLS } from "./image-tools.ts";
import { EXIT, runProgram } from "./program.ts";
import {
	AgentResources,
	compactionSettings,
	createAgentRegistry,
	PINNED_SKILLS_DIR,
	ExecutionEnvs,
	harnessSettings,
	initialModel,
	ModelRuntime,
	SettingsManager,
} from "./setup.ts";
import {
	Approvals,
	createApprovalsExtension,
	createOrchestrationExtension,
	createThroughLineToolsExtension,
	type RuntimeMode,
	ToolLink,
} from "./throughline-extensions.ts";

const { values } = parseArgs({
	options: {
		store: { type: "string" },
		agent: { type: "string" },
		cwd: { type: "string" },
		model: { type: "string" },
		"runtime-mode": { type: "string" },
		"carry-from": { type: "string" },
	},
});
if (!values.store || !values.agent?.trim()) {
	process.stderr.write(
		"usage: main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]\n",
	);
	process.exit(2);
}
const log = (line: string) => process.stderr.write(`${line}\n`);
const cwd = resolve(values.cwd ?? process.cwd());
const settings = SettingsManager.create(cwd);
configureHttp(settings);
// Read once before anything is served, so an invalid compaction value stops the program here with pi's own error,
// never inside a run's prepare step, where Durable reads it again.
try {
	compactionSettings(settings);
} catch (error) {
	log(error instanceof Error ? error.message : String(error));
	process.exit(EXIT.failed);
}
const models = await ModelRuntime.create();
// Before anything is served: a prompt that cannot be had stops the program here, never a Claude turn later.
const standard = await claudeStandardPromptAtStart((provider, modelId) => models.getModel(provider, modelId)?.api);
if (!standard.ok) {
	log(standard.refusal);
	process.exit(EXIT.promptUnavailable);
}
log(`claude standard prompt: claude ${standard.claude_version} sha ${standard.sha256.slice(0, 12)}`);
const claudeStandard = standard.extension;
// Claude requests announce the pinned Claude Code, the one the standard prompt came from, not Pi's built-in version.
const announced = withPinnedClaudeCodeVersion(models, standard.claude_version);
log(announced.log);
const envs = new ExecutionEnvs(cwd);
const initial = initialModel(settings, models, values.model);
const approvals = new Approvals();
if (values["runtime-mode"]) approvals.mode = values["runtime-mode"] as RuntimeMode;
const toolLink = new ToolLink();
// Installed empty under its name; the program installs the stored list before it resumes, and each changed list.
const tools = createThroughLineToolsExtension([], toolLink);
approvals.readOnly = new Set([...READ_ONLY_IMAGE_TOOLS, SEARCH_HISTORY_TOOL]);
// The first SIGTERM or SIGINT closes the program as closing stdin does; a second one ends it outright.
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
const storeDir = resolve(values.store);
const resources = new AgentResources(settings, cwd);
if (!existsSync(join(PINNED_SKILLS_DIR, "show-me/SKILL.md"))) {
	log(`skill commands: no pinned show-me at ${join(PINNED_SKILLS_DIR, "show-me/SKILL.md")}; /show-me is listed as a command only if pi's skills list it`);
}
const images = await loadImageTools(cwd);
if (images.missing !== undefined) log(images.missing);
// Set when the read socket cannot be created (program.ts); the prompt then tells the thread.
let readsUnavailable: string | undefined;
const registryWith = (imageExtension: typeof images.extension) =>
	createAgentRegistry(resources, storeDir, values.agent!, {
		readsUnavailable: () => readsUnavailable,
		// Claude Code's standard prompt renders before every other section.
		first: [claudeStandard],
		after: [
			createToolSearchExtension(),
			createHistoryExtension(),
			imageExtension,
			tools.extension,
			createOrchestrationExtension(process.env),
			createApprovalsExtension(approvals),
		],
	});
let registry: ReturnType<typeof registryWith>;
try {
	registry = registryWith(images.extension);
} catch (error) {
	// The image add-on clashed with another extension (a tool name ThroughLine also sends, say): start without it.
	if (images.missing !== undefined) throw error;
	log(`image tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
	registry = registryWith(images.empty);
}
const code = await runProgram({
	storeDir,
	agentId: values.agent,
	initialAgent: {
		cwd,
		...(initial.model === undefined ? {} : { model: initial.model }),
		...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
	},
	harness: { models: announced.models, registry, settings: harnessSettings(settings), env: envs.env },
	approvals,
	tools: {
		link: toolLink,
		install: (descriptors) => {
			const installed = createThroughLineToolsExtension(descriptors, toolLink);
			registry.install(installed.extension);
			approvals.readOnly = new Set([...installed.readOnly, ...READ_ONLY_IMAGE_TOOLS, SEARCH_HISTORY_TOOL]);
		},
	},
	stop: stop.signal,
	...(values["carry-from"] ? { carryFrom: resolve(values["carry-from"]) } : {}),
	reap: true,
	onReadsUnavailable: (reason) => {
		readsUnavailable = reason;
	},
	input: process.stdin,
	output: process.stdout,
	log,
});
await envs.cleanup(BACKGROUND_CONTEXT);
process.exit(code);
