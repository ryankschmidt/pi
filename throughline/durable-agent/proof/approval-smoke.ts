// A real-model run with approvals on: the bash call waits for a question, the answer lets it run, and a declined
// call is blocked. Prints one JSON line of facts.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/approval-smoke.ts <store dir> [provider/model]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProgram } from "../src/client.ts";

const store = process.argv[2];
if (!store) throw new Error("usage: approval-smoke.ts <store dir> [provider/model]");
const model = process.argv[3] ?? "anthropic/claude-opus-5-5";
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const program = startProgram(process.execPath, [
	main,
	"--store",
	store,
	"--agent",
	"smoke",
	"--cwd",
	store,
	"--model",
	model,
	"--runtime-mode",
	"approval-required",
]);
await program.hello;
const questions: { key: string; tool: string; message: string }[] = [];
let answer: "accept" | "decline" = "accept";
program.onQuestion((question) => {
	questions.push(question);
	void program.call("answer", { key: question.key, answer });
});
const run = async (text: string) => {
	const { submissionId } = (await program.call("submit", {
		content: text,
		requestId: `smoke-${Date.now()}`,
	})) as { submissionId: number };
	return program.call("wait", { submissionId });
};
await run("Run exactly this bash command once: echo approved >> smoke.txt. Then say done.");
answer = "decline";
await run("Run exactly this bash command once: echo declined >> smoke.txt. Then say done.");
const entries = (await program.call("entries", { limit: 200 })) as {
	items: { kind: string; data?: unknown; model?: unknown }[];
};
const file = (() => {
	try {
		return readFileSync(join(store, "smoke.txt"), "utf8");
	} catch {
		return "";
	}
})();
const blocked = entries.items.some((entry) => JSON.stringify(entry.data ?? {}).includes("was declined in ThroughLine"));
const firstSystem = entries.items.find((entry) => entry.kind === "pi.system") as
	| { model?: { sections?: Record<string, string> }[] }
	| undefined;
const firstSection = Object.keys(firstSystem?.model?.[0]?.sections ?? {})[0];
console.log(
	JSON.stringify({
		model,
		questions: questions.map((q) => ({ tool: q.tool, message: q.message })),
		file,
		blocked,
		entryKinds: [...new Set(entries.items.map((entry) => entry.kind))],
		firstSection,
	}),
);
program.child.stdin?.end();
await program.exited;
