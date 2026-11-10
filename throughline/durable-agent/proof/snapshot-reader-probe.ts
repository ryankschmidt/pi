// One-off probe on this Mac (build round 8): a real conversation_snapshot, written by the agent program after a rewind,
// read by Tier 1 show-me's reader; and an older multi-branch transcript.jsonl refused by it. It needs show-me's Tier 1
// source on this Mac, so it is a proof script, not a fork test.
//   node proof/snapshot-reader-probe.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromDurable, sentences } from "/Users/Admin/core-root/vault/01_Projects/workbench/tools/show-me/src/transcript.ts";
import { startProgram } from "../src/client.ts";

const reader = { fromDurable, sentences };
const fixture = fileURLToPath(new URL("../test/fixtures/faux-snapshot-program.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "snapshot-reader-probe-"));
const program = startProgram(process.execPath, [fixture, join(root, "store"), root]);
await program.hello;
const turn = async (content: string, requestId: string) => {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	await program.call("wait", { submissionId });
};
type Entry = { id: number; model?: { role: string; content: unknown; toolName?: string }[] };
const entries = async () => ((await program.call("entries", { limit: 100 })) as { items: Entry[] }).items;
await turn("Retained decision.", "a");
await turn("Withdrawn choice.", "b");
const withdrawn = (await entries()).find((entry) => entry.model?.[0]?.content === "Withdrawn choice.");
await program.call("forkBefore", { entryId: withdrawn?.id });
await turn("New branch choice.", "c");
await turn("snapshot please", "d");
const result = (await entries()).flatMap((entry) => entry.model ?? []).filter((m) => m.toolName === "conversation_snapshot").at(-1);
const path = (result?.content as { text: string }[])[0]?.text as string;
console.log(`snapshot read by show-me: ${JSON.stringify(reader.sentences(reader.fromDurable(readFileSync(path, "utf8"))))}`);
await program.call("drain");
// Rereview7-3's legacy example: retained entry 1, withdrawn entry 2, a fork at entry 1, new-branch entry 3.
const user = (id: number, conversationId: number, content: string) => ({ id, conversationId, kind: "pi.user", model: [{ role: "user", content }] });
const legacy = [
	{ seq: 1, conversation: { id: 1 } },
	{ seq: 2, entry: user(1, 1, "Retained decision.") },
	{ seq: 3, entry: user(2, 1, "Withdrawn choice.") },
	{ seq: 4, conversation: { id: 3, parent: { conversationId: 1, at: 1 } } },
	{ seq: 5, entry: user(3, 3, "New branch choice.") },
].map((line) => JSON.stringify(line)).join("\n");
try {
	reader.fromDurable(legacy);
	console.log("legacy transcript: READ (wrong)");
} catch (error) {
	console.log(`legacy transcript refused: ${(error as Error).message}`);
}
process.exit(0);
