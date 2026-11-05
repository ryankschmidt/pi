// Does the model stream its answer after a tool result? Calls pi-ai directly, outside Durable, and prints when each
// kind of stream event first arrives.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/provider-probe.ts [provider] [model] [thinking]
import { ModelRuntime } from "../src/setup.ts";

const [provider = "anthropic", modelId = "claude-opus-5-5", reasoning = "low"] = process.argv.slice(2);
const models = await ModelRuntime.create();
const model = models.getModel(provider, modelId);
if (!model) throw new Error(`no model ${provider}/${modelId}`);
const t0 = Date.now();
const noTool = process.env.PROBE_NO_TOOL === "1";
const allMessages = [
	{ role: "user", content: "Run echo hi with bash, then count from 1 to 120, one number per line.", timestamp: t0 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_probe1", name: "bash", arguments: { command: "echo hi" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: t0,
	},
	{ role: "toolResult", toolCallId: "toolu_probe1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: t0 },
] as never;
const messages = (noTool ? (allMessages as unknown[]).slice(0, 1) : allMessages) as never;
const tools = [
	{ name: "bash", description: "Run a bash command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
] as never;
const seen = new Map<string, number>();
let events = 0;
let lastDelta = 0;
const stream = models.streamSimple(model, { messages, tools }, { reasoning } as never);
for await (const event of stream) {
	events++;
	if (!seen.has(event.type)) seen.set(event.type, Date.now() - t0);
	if (event.type === "text_delta") lastDelta = Date.now() - t0;
}
const result = await stream.result();
console.log(JSON.stringify({ events, firstSeenMs: Object.fromEntries(seen), stopReason: result.stopReason, lastDeltaMs: lastDelta, totalMs: Date.now() - t0 }));
