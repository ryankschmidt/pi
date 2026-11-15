// The agent program with ThroughLine's real approvals and tools add-ons over a scripted fake model, for the approval
// restart tests. "bash <call id>: <command>" makes the model run that command under that tool call id (the approval's
// key); "tool: <name>" makes it call ThroughLine's tool
// <name>; anything else, and every tool result, is answered "done".
//   node faux-approvals-program.ts <store dir> <cwd> [gate]
// With "gate", a hook after the approvals hook writes <cwd>/gate-reached and then holds the call, so a test can kill the
// program after the decision is stored and before the tool runs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { runProgram } from "../../src/program.ts";
import {
	Approvals,
	createApprovalsExtension,
	createThroughLineToolsExtension,
	ToolLink,
} from "../../src/throughline-extensions.ts";

const [storeDir, cwd, gate] = process.argv.slice(2) as [string, string, string?];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const answer = (context: { messages: { role: string; content: unknown }[] }) => {
	const last = context.messages.at(-1);
	const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
	const bash = /^bash (\S+): (.*)$/s.exec(text);
	if (bash !== null) {
		return fauxAssistantMessage(fauxToolCall("bash", { command: bash[2] }, { id: bash[1] }), { stopReason: "toolUse" });
	}
	const tool = /^tool: (\S+)$/.exec(text)?.[1];
	if (tool !== undefined) return fauxAssistantMessage(fauxToolCall(`throughline__${tool}`, {}), { stopReason: "toolUse" });
	return fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 1000 }, () => answer));

const approvals = new Approvals();
const link = new ToolLink();
const registry = createRegistry();
registry.install(CodingTools);
registry.install(createThroughLineToolsExtension([], link).extension);
registry.install(createApprovalsExtension(approvals));
if (gate === "gate") {
	registry.install(
		defineExtension({
			name: "test-gate",
			hooks: [
				hook(ToolTask, {
					beforeTool: async () => {
						writeFileSync(join(cwd, "gate-reached"), "");
						await new Promise(() => undefined);
						return undefined;
					},
				}),
			],
		}),
	);
}
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
	approvals,
	tools: {
		link,
		install: (descriptors) => {
			const installed = createThroughLineToolsExtension(descriptors, link);
			registry.install(installed.extension);
			approvals.readOnly = installed.readOnly;
		},
	},
	stop: stop.signal,
	input: process.stdin,
	output: process.stdout,
});
process.exit(code);
