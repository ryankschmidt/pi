// The agent program over a scripted fake model, for the read-socket tests: a user message "bash: <command>" makes the
// model run that command, as a skill body would; every other message is answered "done".
//   node faux-bash-program.ts <store dir> <cwd> [<stock Pi session file to carry>]
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { runProgram } from "../../src/program.ts";

const [storeDir, cwd, carryFrom] = process.argv.slice(2) as [string, string, string?];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const answer = (context: { messages: { role: string; content: unknown }[] }) => {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return fauxAssistantMessage("done");
	// "bash: <command>" makes the model run that command, as a skill body would tell it to.
	const command = typeof last.content === "string" ? /^bash: (.*)$/s.exec(last.content)?.[1] : undefined;
	return command === undefined ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 1000 }, () => answer));
const registry = createRegistry();
registry.install(CodingTools);
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
	...(carryFrom === undefined ? {} : { carryFrom }),
	input: process.stdin,
	output: process.stdout,
});
process.exit(code);
