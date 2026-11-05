#!/usr/bin/env node
// Command line of the Pi Durable agent program.
//   node src/main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model]
// Models, logins, settings and skills come from pi's agent folder (PI_CODING_AGENT_DIR, default ~/.pi/agent).

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

const { values } = parseArgs({
	options: {
		store: { type: "string" },
		agent: { type: "string" },
		cwd: { type: "string" },
		model: { type: "string" },
	},
});
if (!values.store || !values.agent) {
	process.stderr.write("usage: main.ts --store <dir> --agent <id> --cwd <dir> [--model provider/model]\n");
	process.exit(2);
}
const cwd = resolve(values.cwd ?? process.cwd());
const settings = SettingsManager.create(cwd);
configureHttp(settings);
const models = await ModelRuntime.create();
const envs = new ExecutionEnvs(cwd);
const initial = await initialModel(settings, models, values.model);
const code = await runProgram({
	storeDir: resolve(values.store),
	agentId: values.agent,
	initialAgent: {
		cwd,
		...(initial.model === undefined ? {} : { model: initial.model }),
		...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
	},
	harness: {
		models,
		registry: createAgentRegistry(settings, cwd),
		settings: harnessSettings(settings),
		env: envs.env,
	},
	input: process.stdin,
	output: process.stdout,
});
await envs.cleanup(BACKGROUND_CONTEXT);
process.exit(code);
