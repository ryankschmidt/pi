// The agent program with Pi extensions bridged in, over a scripted fake model, for the bridge tests.
//   node faux-bridge-program.ts <store dir> <cwd> <extension file>...
// The script: inspect_image on dot.png, then a bash edit, then (after the test asks for a compaction) one more bash
// edit, which a post-boundary hold must block.
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { bridgePiExtensions } from "../../src/pi-extension-bridge.ts";
import { runProgram } from "../../src/program.ts";

const [storeDir, cwd, ...paths] = process.argv.slice(2) as [string, string, ...string[]];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("inspect_image", { image_path: "dot.png" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("seen"),
	fauxAssistantMessage(fauxToolCall("bash", { command: "echo one >> a.txt" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("edited"),
	fauxAssistantMessage(fauxToolCall("bash", { command: "echo two >> a.txt" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("held"),
]);
const log = (line: string) => process.stderr.write(`${line}\n`);
const bridge = await bridgePiExtensions(paths, { cwd, contextWindow: () => 200_000, log });
const registry = createRegistry();
registry.install(CodingTools);
for (const extension of bridge.extensions) registry.install(extension);
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: {
		models,
		registry,
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }),
	},
	input: process.stdin,
	output: process.stdout,
	log,
});
process.exit(code);
