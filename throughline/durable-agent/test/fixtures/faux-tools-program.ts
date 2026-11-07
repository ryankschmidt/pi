// The agent program over a scripted fake model that calls one ThroughLine tool, for the tool-link test.
//   node faux-tools-program.ts <store dir> <cwd>
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { runProgram } from "../../src/program.ts";
import { createThroughLineToolsExtension, ToolLink } from "../../src/throughline-extensions.ts";

const [storeDir, cwd] = process.argv.slice(2) as [string, string];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("throughline__task_status", { taskId: "task-1" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("done"),
]);
const link = new ToolLink();
const tools = createThroughLineToolsExtension(
	[{ name: "task_status", description: "Read one delegated task.", inputSchema: { type: "object" }, readOnly: true }],
	link,
);
const registry = createRegistry();
registry.install(tools.extension);
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
	tools: link,
	input: process.stdin,
	output: process.stdout,
});
process.exit(code);
