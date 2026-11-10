// Build round 10 probe on this Mac (Rereview9-1 #1 and #2): one disposable store taken through the real old agent program
// (the installed copy's own scripted-model fixture), an upgrade to this agent program, a rewind, and a rollback to the old
// program, read at each step by Tier 1 show-me's reader. It needs the installed agent and show-me's Tier 1 source, so it is
// a proof script, not a fork test.   node proof/upgrade-probe.ts
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromDurable, sentences } from "/Users/Admin/core-root/vault/01_Projects/workbench/tools/show-me/src/transcript.ts";
import { type AgentProgram, startProgram } from "../src/client.ts";

const OLD = "/Users/Admin/.local/share/pi-durable-agent/current/throughline/durable-agent/test/fixtures/faux-program.ts";
const NEW = fileURLToPath(new URL("../test/fixtures/faux-snapshot-program.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "upgrade-probe-"));
const store = join(root, "store");
const transcript = join(store, "transcript.jsonl");
const aside = join(store, "transcript.superseded-by-conversation-snapshot.jsonl");
type Entry = { id: number; model?: { role: string; content: unknown; toolName?: string }[] };
const turn = async (program: AgentProgram, content: string, requestId: string) => {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	await program.call("wait", { submissionId });
};
const entries = async (program: AgentProgram) => ((await program.call("entries", { limit: 200 })) as { items: Entry[] }).items;
const read = (path: string) => {
	try {
		return JSON.stringify(sentences(fromDurable(readFileSync(path, "utf8"), path)));
	} catch (error) {
		return `REFUSED: ${(error as Error).message.split(". ")[0]}`;
	}
};
const run = async (fixture: string, label: string, work: (program: AgentProgram) => Promise<void>) => {
	const program = startProgram(process.execPath, [fixture, store, root]);
	await program.hello;
	console.log(`-- ${label}`);
	await work(program);
	await program.call("drain");
	await program.exited;
};

await run(OLD, "1. installed old agent program", async (program) => {
	await turn(program, "Old choice.", "a");
	console.log(`transcript.jsonl written by the old program: ${existsSync(transcript)}; show-me reads ${read(transcript)}`);
});
await run(NEW, "2. upgraded to this agent program", async (program) => {
	console.log(`at start: transcript.jsonl present: ${existsSync(transcript)}; set-aside file present: ${existsSync(aside)}`);
	await turn(program, "New decision after upgrade.", "b");
	console.log(`after a new turn: transcript.jsonl present: ${existsSync(transcript)}; set-aside file read by show-me: ${read(aside)}`);
	await turn(program, "Withdrawn later.", "c");
	await turn(program, "snapshot please", "d");
	const all = await entries(program);
	const snapshot = (all.flatMap((e) => e.model ?? []).filter((m) => m.toolName === "conversation_snapshot").at(-1)?.content as { text: string }[])[0]?.text as string;
	console.log(`snapshot read by show-me: ${read(snapshot)}`);
	const withdrawn = all.find((e) => e.model?.[0]?.content === "Withdrawn later.");
	await program.call("forkBefore", { entryId: withdrawn?.id });
	await turn(program, "Replacement after rewind.", "e");
	const folder = join(store, "snapshots");
	const listed = readdirSync(folder).filter((name) => readFileSync(join(folder, name), "utf8").includes("Withdrawn later."));
	console.log(`after the rewind, files in the snapshots folder holding the withdrawn turn: ${listed.length} (${readdirSync(folder).length} files listed)`);
});
await run(OLD, "3. rolled back to the installed old agent program", async (program) => {
	await turn(program, "Back on the old program.", "f");
	console.log(`transcript.jsonl rebuilt by the old program: ${existsSync(transcript)}; show-me reads ${read(transcript)}`);
});
process.exit(0);
