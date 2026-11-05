// Does a plain text answer (no tools at all) stream through the broker? Prints first and last text_delta times.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/text-probe.ts
import { ModelRuntime } from "../src/setup.ts";

const models = await ModelRuntime.create();
const model = models.getModel("anthropic", "claude-opus-5-5");
if (!model) throw new Error("no model");
const t0 = Date.now();
const times: number[] = [];
const messages = [{ role: "user", content: "Count from 1 to 120, one number per line, nothing else.", timestamp: t0 }] as never;
const stream = models.streamSimple(model, { messages }, { reasoning: "low" } as never);
for await (const event of stream) if (event.type === "text_delta") times.push(Date.now() - t0);
console.log(JSON.stringify({ deltas: times.length, firstMs: times[0], lastMs: times.at(-1), spreadMs: (times.at(-1) ?? 0) - (times[0] ?? 0) }));
