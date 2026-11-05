#!/usr/bin/env node
// Command line of the Pi Durable agent program.
//   node src/main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]
// Models, logins, settings and skills come from pi's agent folder (PI_CODING_AGENT_DIR, default ~/.pi/agent).
// ThroughLine passes its MCP endpoint and credential (T3_MCP_URL, T3_MCP_BEARER_TOKEN) and its orchestration
// instructions (T3_CODE_ORCHESTRATION_INSTRUCTIONS) in the environment, as it does for its stock Pi bridge.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createClaudeStandardPromptExtension } from "./claude-standard-prompt.ts";
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
	createMcpExtension,
	createOrchestrationExtension,
	type RuntimeMode,
} from "./throughline-extensions.ts";

const { values } = parseArgs({
	options: {
		store: { type: "string" },
		agent: { type: "string" },
		cwd: { type: "string" },
		model: { type: "string" },
		"runtime-mode": { type: "string" },
	},
});
if (!values.store || !values.agent) {
	process.stderr.write(
		"usage: main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model] [--runtime-mode <mode>]\n",
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
const mcp = await createMcpExtension(process.env, log);
const registry = createAgentRegistry(settings, cwd, {
	// Claude Code's standard prompt renders before every other section.
	first: [createClaudeStandardPromptExtension((provider, modelId) => models.getModel(provider, modelId)?.api)],
	after: [
		createToolSearchExtension(),
		mcp.extension,
		createOrchestrationExtension(process.env),
		createApprovalsExtension(approvals, mcp.readOnly),
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
	reap: true,
	input: process.stdin,
	output: process.stdout,
	log,
});
await mcp.close().catch(() => undefined);
await envs.cleanup(BACKGROUND_CONTEXT);
process.exit(code);
