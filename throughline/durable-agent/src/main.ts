#!/usr/bin/env node
// Command line of the Pi Durable agent program.
//   node src/main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]
//                    [--tools <file>] [--carry-from <stock Pi session file>]
// Models, logins, settings and skills come from pi's agent folder (PI_CODING_AGENT_DIR, default ~/.pi/agent).
// ThroughLine passes the list of its tools as a JSON file (--tools) and its orchestration instructions
// (T3_CODE_ORCHESTRATION_INSTRUCTIONS) in the environment. Tool calls go back to ThroughLine over stdin and stdout;
// no MCP endpoint or credential is passed to the agent.
// Pi extensions installed for stock Pi threads (<agent dir>/extensions, and <cwd>/.pi/extensions) run here too through
// the Pi-extension bridge; one stderr line per extension says what was mapped onto Durable and what was not.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { getAgentDir } from "../../../packages/coding-agent/dist/config.js";
import { createClaudeStandardPromptExtension } from "./claude-standard-prompt.ts";
import { bridgePiExtensions, discoverPiExtensions } from "./pi-extension-bridge.ts";
import { runProgram } from "./program.ts";
import {
	configureHttp,
	createAgentRegistry,
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
const initial = await initialModel(settings, models, values.model);
const approvals = new Approvals();
if (values["runtime-mode"]) approvals.mode = values["runtime-mode"] as RuntimeMode;
const toolLink = new ToolLink();
const descriptors: ToolDescriptor[] = values.tools ? JSON.parse(readFileSync(resolve(values.tools), "utf8")) : [];
const tools = createThroughLineToolsExtension(descriptors, toolLink);
const bridged = await bridgePiExtensions(discoverPiExtensions(cwd, getAgentDir()), {
	cwd,
	contextWindow: (provider, modelId) => models.getModel(provider, modelId)?.contextWindow,
	log,
});
const registry = createAgentRegistry(settings, cwd, {
	// Claude Code's standard prompt renders before every other section.
	first: [createClaudeStandardPromptExtension((provider, modelId) => models.getModel(provider, modelId)?.api)],
	after: [
		createToolSearchExtension(),
		tools.extension,
		createOrchestrationExtension(process.env),
		// Before approvals, so a call an extension blocks is never put to the user.
		...bridged.extensions,
		createApprovalsExtension(approvals, new Set([...tools.readOnly, ...bridged.readOnly])),
	],
});
const code = await runProgram({
	storeDir: resolve(values.store),
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
	input: process.stdin,
	output: process.stdout,
	log,
});
await envs.cleanup(BACKGROUND_CONTEXT);
process.exit(code);
