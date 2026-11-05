// The agent program over a scripted fake model, for the unit tests. The real entry is src/main.ts.
//   node faux-program.ts <store dir> <cwd>
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { runProgram } from "../../src/program.ts";

const [storeDir, cwd] = process.argv.slice(2) as [string, string];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
// Every answer first runs bash writing one line, then answers.
faux.setResponses(
	Array.from({ length: 6 }, () => [
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo line >> effect.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]).flat(),
);
const registry = createRegistry();
registry.install(CodingTools);
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
	input: process.stdin,
	output: process.stdout,
});
process.exit(code);
