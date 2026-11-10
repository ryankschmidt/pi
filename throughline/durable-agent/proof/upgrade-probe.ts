// Build round 11 probe on this Mac (Rereview10-1, 10-2, 10-3): one disposable store taken through the real old agent
// program (the installed copy's scripted-model fixture), an upgrade to this agent program, a rewind, and a rollback to
// the old program. Show-me's real CLI (Tier 1 build) is run by each program's own command tool, as a skill body tells
// the model to, so it sees exactly the environment the running agent gives its commands. The reviewers' failed-cleanup
// setup (a directory where round 10 moved the old file) is placed first; nothing in this round touches that path.
// Needs the installed agent and show-me's Tier 1 build, so it is a proof script.   node proof/upgrade-probe.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";

const OLD = "/Users/Admin/.local/share/pi-durable-agent/current/throughline/durable-agent/test/fixtures/faux-program.ts";
const NEW = fileURLToPath(new URL("../test/fixtures/faux-snapshot-program.ts", import.meta.url));
const SHOW_ME = "/Users/Admin/core-root/vault/01_Projects/workbench/tools/show-me/dist/cli.js";
const WORDS = "Old choice[.]|New decision after upgrade[.]|Withdrawn later[.]|Replacement after rewind[.]|Back on the old program[.]";
const root = mkdtempSync(join(tmpdir(), "upgrade-probe-"));
const store = join(root, "store");
const transcript = join(store, "transcript.jsonl");
const spec = join(root, "spec.json");
writeFileSync(spec, JSON.stringify({ form: "options", title: "Choices", columns: ["Value"], rows: [{ label: "First", cells: [{ text: "Keep", state: "good", claim: "written" }], evidence: "Evidence here" }], call: "Choose one", honesty: "Proposed only." }));
type Entry = { id: number; model?: { role: string; content: unknown; toolName?: string }[] };
const turn = async (program: AgentProgram, content: string, requestId: string) => {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	await program.call("wait", { submissionId });
};
const entries = async (program: AgentProgram) => ((await program.call("entries", { limit: 300 })) as { items: Entry[] }).items;
const lastToolText = async (program: AgentProgram, tool: string) =>
	((await entries(program)).flatMap((e) => e.model ?? []).filter((m) => m.toolName === tool).at(-1)?.content as { text: string }[] | undefined)?.map((c) => c.text).join("") ?? "";
/** Run show-me build on `path` through the program's own command tool (the old program has no scripted bash; it runs here with no declaration, as its commands would). */
const build = async (program: AgentProgram | undefined, path: string, tag: string) => {
	const out = join(root, `${tag}.html`);
	const command = `node ${SHOW_ME} build ${spec} --transcript ${path} --out ${out} 2>&1; echo "exit=$?"; echo "words on the page: $(grep -oE '${WORDS}' ${out} 2>/dev/null | sort -u | tr '\\n' '|')"; true`;
	if (program === undefined) {
		return execFileSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, PI_DURABLE_TRANSCRIPT: "" } });
	}
	await turn(program, `bash: ${command}`, tag);
	return lastToolText(program, "bash");
};
const run = async (fixture: string, label: string, work: (program: AgentProgram) => Promise<void>) => {
	const program = startProgram(process.execPath, [fixture, store, root]);
	await program.hello;
	console.log(`-- ${label}`);
	await work(program);
	await program.call("drain");
	await program.exited;
};
const short = (text: string) => { const s = text.replace(/\s+/g, " "); return s.length > 420 ? `${s.slice(0, 200)} … ${s.slice(-200)}` : s; };

await run(OLD, "1. installed old agent program", async (program) => {
	await turn(program, "Old choice.", "a");
});
console.log(`old program wrote transcript.jsonl: ${existsSync(transcript)}; show-me build from it (old agent, no declaration): ${short(await build(undefined, transcript, "old"))}`);
mkdirSync(join(store, "transcript.superseded-by-conversation-snapshot.jsonl"));
const before = readFileSync(transcript, "utf8");
await run(NEW, "2. upgraded to this agent program (round-10 failed-cleanup setup in place)", async (program) => {
	await turn(program, "New decision after upgrade.", "b");
	console.log(`transcript.jsonl byte-unchanged by the new program: ${readFileSync(transcript, "utf8") === before}`);
	console.log(`old skill body path (transcript.jsonl) through the agent's command tool: ${short(await build(program, transcript, "replayed-old-skill"))}`);
	await turn(program, "Withdrawn later.", "c");
	await turn(program, "snapshot please", "d");
	const snapshot = await lastToolText(program, "conversation_snapshot");
	console.log(`snapshot path through the agent's command tool: ${short(await build(program, snapshot, "snapshot"))}`);
	const withdrawn = (await entries(program)).find((e) => e.model?.[0]?.content === "Withdrawn later.");
	await program.call("forkBefore", { entryId: withdrawn?.id });
	await turn(program, "Replacement after rewind.", "e");
	const folder = join(store, "snapshots");
	const names = existsSync(folder) ? readdirSync(folder) : [];
	console.log(`after the rewind: ${names.length} files in the snapshots folder, ${names.filter((n) => readFileSync(join(folder, n), "utf8").includes("Withdrawn later.")).length} holding the withdrawn turn`);
});
await run(OLD, "3. rolled back to the installed old agent program", async (program) => {
	await turn(program, "Back on the old program.", "f");
});
console.log(`show-me build from transcript.jsonl after rollback (old agent, no declaration): ${short(await build(undefined, transcript, "rollback"))}`);
process.exit(0);
