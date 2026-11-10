#!/usr/bin/env node
// Command line of the Pi Durable agent program.
//   node src/main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]
//                    [--tools <file>] [--carry-from <stock Pi session file>]
// Models, logins, settings and skills come from pi's agent folder (PI_CODING_AGENT_DIR, default ~/.pi/agent).
// ThroughLine passes the list of its tools as a JSON file (--tools) and its orchestration instructions
// (T3_CODE_ORCHESTRATION_INSTRUCTIONS) in the environment. Tool calls go back to ThroughLine over stdin and stdout;
// no MCP endpoint or credential is passed to the agent.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createClaudeStandardPromptExtension } from "./claude-standard-prompt.ts";
import { configureHttp } from "./http.ts";
import { loadImageTools, READ_ONLY_IMAGE_TOOLS } from "./image-tools.ts";
import { runProgram } from "./program.ts";
import {
	AgentResources,
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
	type ToolDescriptor,
	ToolLink,
} from "./throughline-extensions.ts";

const { values } = parseArgs({
	options: {
		store: { type: "string" },
		agent: { type: "string" },
		cwd: { type: "string" },
		model: { type: "string" },
		"runtime-mode": { type: "string" },
		tools: { type: "string" },
		"carry-from": { type: "string" },
	},
});
if (!values.store || !values.agent) {
	process.stderr.write(
		"usage: main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>] [--tools <file>]\n",
	);
	process.exit(2);
}
const log = (line: string) => process.stderr.write(`${line}\n`);
const cwd = resolve(values.cwd ?? process.cwd());
const settings = SettingsManager.create(cwd);
configureHttp(settings);
const models = await ModelRuntime.create();
const envs = new ExecutionEnvs(cwd);
const initial = initialModel(settings, models, values.model);
const approvals = new Approvals();
if (values["runtime-mode"]) approvals.mode = values["runtime-mode"] as RuntimeMode;
const toolLink = new ToolLink();
const descriptors: ToolDescriptor[] = values.tools ? JSON.parse(readFileSync(resolve(values.tools), "utf8")) : [];
const tools = createThroughLineToolsExtension(descriptors, toolLink);
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
	createAgentRegistry(resources, storeDir, {
		readsUnavailable: () => readsUnavailable,
		// Claude Code's standard prompt renders before every other section.
		first: [createClaudeStandardPromptExtension((provider, modelId) => models.getModel(provider, modelId)?.api)],
		after: [
			createToolSearchExtension(),
			imageExtension,
			tools.extension,
			createOrchestrationExtension(process.env),
			createApprovalsExtension(approvals, new Set([...tools.readOnly, ...READ_ONLY_IMAGE_TOOLS])),
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
	harness: { models, registry, settings: harnessSettings(settings), env: envs.env },
	approvals,
	tools: toolLink,
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
