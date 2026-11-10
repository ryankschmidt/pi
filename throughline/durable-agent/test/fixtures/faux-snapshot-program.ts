// The agent program with the conversation_snapshot tool over a scripted fake model, for the snapshot tests: a user
// message starting with "snapshot" makes the model call the tool; every other message is answered "done".
//   node faux-snapshot-program.ts <store dir> <cwd> [page size]
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createConversationSnapshotExtension } from "../../src/conversation-snapshot.ts";
import { runProgram } from "../../src/program.ts";

const [storeDir, cwd, pageSize] = process.argv.slice(2) as [string, string, string | undefined];
const faux = fauxProvider({ provider: "faux-test", api: "faux-test" });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const answer = (context: { messages: { role: string; content: unknown }[] }) => {
	const last = context.messages.at(-1);
	const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
	return last?.role === "user" && /^\W*(\[\{"type":"text","text":")?snapshot/.test(text)
		? fauxAssistantMessage(fauxToolCall("conversation_snapshot", {}), { stopReason: "toolUse" })
		: fauxAssistantMessage("done");
};
faux.setResponses(Array.from({ length: 1000 }, () => answer));
const registry = createRegistry();
registry.install(CodingTools);
registry.install(createConversationSnapshotExtension(storeDir, pageSize === undefined ? undefined : Number(pageSize)));
const code = await runProgram({
	storeDir,
	agentId: "test-agent",
	initialAgent: { cwd, model: { provider: model.provider, modelId: model.id } },
	harness: { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
	input: process.stdin,
	output: process.stdout,
});
process.exit(code);
