// Build round 12 and 13 probe on this Mac (Design brief 5; Rereview11-1 #2, 11-3 #1): one disposable store taken through the
// real old agent program (the installed copy's scripted-model fixture), an upgrade to this program, a rewind, a crash,
// and a rollback to the old program. Show-me's real CLI (Tier 1 build) runs through each program's own command tool, as
// a skill body tells the model to: the old body's path (<store>/transcript.jsonl) and the new prompt's (<store>).
// Needs the installed agent and show-me's Tier 1 build, so it is a proof script.   node proof/upgrade-probe.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";

const OLD = "/Users/Admin/.local/share/pi-durable-agent/current/throughline/durable-agent/test/fixtures/faux-program.ts";
const NEW = fileURLToPath(new URL("../test/fixtures/faux-bash-program.ts", import.meta.url));
const SHOW_ME = "/Users/Admin/core-root/vault/01_Projects/workbench/tools/show-me/dist/cli.js";
const WORDS = "Old choice[.]|New decision after upgrade[.]|Withdrawn later[.]|Replacement after rewind[.]|After the crash[.]|Back on the old program[.]";
const root = mkdtempSync(join(tmpdir(), "upgrade-probe-"));
const store = join(root, "store");
const spec = join(root, "spec.json");
writeFileSync(spec, JSON.stringify({ form: "options", title: "Choices", columns: ["Value"], rows: [{ label: "First", cells: [{ text: "Keep", state: "good", claim: "written" }], evidence: "Evidence here" }], call: "Choose one", honesty: "Proposed only." }));
type Entry = { id: number; model?: { role: string; content: unknown; toolName?: string }[] };
const turn = async (program: AgentProgram, content: string, requestId: string) => {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	await program.call("wait", { submissionId });
};
const entries = async (program: AgentProgram) => ((await program.call("entries", { limit: 300 })) as { items: Entry[] }).items;
const lastBash = async (program: AgentProgram) =>
	((await entries(program)).flatMap((e) => e.model ?? []).filter((m) => m.toolName === "bash").at(-1)?.content as { text: string }[] | undefined)?.map((c) => c.text).join("") ?? "";
let serial = 0;
/** show-me build on `path` asked to quote `newest`; through the program's command tool when given, else from outside any agent. The phrase is found only if the read holds that turn. */
const build = async (program: AgentProgram | undefined, path: string, newest: string) => {
	const out = join(root, `page-${++serial}.html`);
	const command = `node ${SHOW_ME} build ${spec} --transcript ${path} --words "${newest}" --out ${out} > ${out}.log 2>&1; echo "exit=$?"; grep -q "legacy Pi Durable" ${out}.log && echo "label=legacy"; grep -m1 -oE "agent isn.t running|run by an older agent program now" ${out}.log; if [ -f ${out} ]; then grep -q "picked from this thread" ${out} && echo "newest turn NOT found (picked)" || echo "newest turn found: ${newest}"; else echo "no page"; fi; echo "words=$(grep -oE '${WORDS}' ${out} 2>/dev/null | sort -u | tr '\\n' '|')"; true`;
	if (program === undefined) return execFileSync("bash", ["-c", command], { encoding: "utf8" }).replace(/\s+/g, " ").trim();
	await turn(program, `bash: ${command}`, `b${serial}`);
	return (await lastBash(program)).replace(/\s+/g, " ").trim();
};
const run = async (fixture: string, label: string, work: (program: AgentProgram) => Promise<void>, kill = false) => {
	const program = startProgram(process.execPath, [fixture, store, root]);
	await program.hello;
	console.log(`-- ${label}`);
	await work(program);
	if (kill) program.kill();
	else await program.call("drain");
	await program.exited;
};
const owner = () => JSON.parse(readFileSync(join(store, "owner.lock"), "utf8")) as { reads?: { socket?: string } };

await run(OLD, "1. installed old agent program", async (program) => {
	await turn(program, "Old choice.", "a");
	console.log(`old record names a socket: ${owner().reads?.socket !== undefined}; show-me from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Old choice.")}`);
});
const before = readFileSync(join(store, "transcript.jsonl"), "utf8");
await run(
	NEW,
	"2. upgraded to this program; then killed (a crash)",
	async (program) => {
		await turn(program, "New decision after upgrade.", "b");
		console.log(`old skill body path (transcript.jsonl), through the agent: ${await build(program, join(store, "transcript.jsonl"), "New decision after upgrade.")}`);
		console.log(`new prompt path (store folder), through the agent: ${await build(program, store, "New decision after upgrade.")}`);
		await turn(program, "Withdrawn later.", "c");
		const withdrawn = (await entries(program)).find((e) => e.model?.[0]?.content === "Withdrawn later.");
		await program.call("forkBefore", { entryId: withdrawn?.id });
		await turn(program, "Replacement after rewind.", "d");
		console.log(`after a rewind, old body path: ${await build(program, join(store, "transcript.jsonl"), "Replacement after rewind.")}`);
		console.log(`transcript.jsonl byte-unchanged by the new program: ${readFileSync(join(store, "transcript.jsonl"), "utf8") === before}`);
	},
	true,
);
console.log(`after the crash, show-me from outside (record names a dead socket): ${await build(undefined, join(store, "transcript.jsonl"), "Replacement after rewind.")}`);
await run(NEW, "3. restarted after the crash", async (program) => {
	await turn(program, "After the crash.", "e");
	console.log(`old body path, through the agent: ${await build(program, join(store, "transcript.jsonl"), "After the crash.")}`);
});
// Round 13 item 1: after a clean stop no owner record exists; the marked store is refused by build and by review.
const review = () => execFileSync("bash", ["-c", `node ${SHOW_ME} review ${store} --out ${join(root, "review")} > ${root}/review.log 2>&1; echo "exit=$?"; grep -m1 -o "agent isn.t running" ${root}/review.log; true`], { encoding: "utf8" }).replace(/\s+/g, " ").trim();
console.log(`after a clean stop, store marked: ${existsSync(join(store, "owner-reads.v1"))}; owner record: ${existsSync(join(store, "owner.lock"))}; show-me build from outside: ${await build(undefined, join(store, "transcript.jsonl"), "After the crash.")}; review from outside: ${review()}`);
await run(OLD, "4. rolled back to the installed old agent program", async (program) => {
	await turn(program, "Back on the old program.", "f");
	console.log(`record names a socket: ${owner().reads?.socket !== undefined}; show-me from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Back on the old program.")}`);
});
// Lead's ruling: with the old program running (a live owner.lock with no read socket) show-me reads its rebuilt file;
// with nothing running the marked store is refused.
console.log(`rolled back, old program stopped: store marked: ${existsSync(join(store, "owner-reads.v1"))}; owner record: ${existsSync(join(store, "owner.lock"))}; show-me from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Back on the old program.")}`);
process.exit(0);
