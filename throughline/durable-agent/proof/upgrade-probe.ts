// Build rounds 12 to 15 probe on this Mac (Design brief 5; Rereview11-1 #2, 11-3 #1, 13-1 #1/#2, 13-2 #1, 13-3 #1/#2): one
// disposable store taken through the real installed old agent program, an upgrade to this program, a rewind, a crash,
// a clean stop, and a rollback to the old program, running and then stopped. Show-me's real CLI (Tier 1 build) runs
// through each program's own command tool, as a skill body tells the model to, and from outside any agent. The old
// program runs its own installed code over a scripted model that runs the bash a user message names; its fixture is
// generated beside a link to the installed node_modules, so nothing is written into the installed runtime.
// Needs the installed agent and show-me's Tier 1 build, so it is a proof script.   node proof/upgrade-probe.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";

const INSTALLED = "/Users/Admin/.local/share/pi-durable-agent/current";
const NEW = fileURLToPath(new URL("../test/fixtures/faux-bash-program.ts", import.meta.url));
const SHOW_ME = "/Users/Admin/core-root/vault/01_Projects/workbench/tools/show-me/dist/cli.js";
const WORDS = "Old choice[.]|New decision after upgrade[.]|Withdrawn later[.]|Replacement after rewind[.]|After the crash[.]|Back on the old program[.]";
const root = mkdtempSync(join(tmpdir(), "upgrade-probe-"));
const store = join(root, "store");
const spec = join(root, "spec.json");
writeFileSync(spec, JSON.stringify({ form: "options", title: "Choices", columns: ["Value"], rows: [{ label: "First", cells: [{ text: "Keep", state: "good", claim: "written" }], evidence: "Evidence here" }], call: "Choose one", honesty: "Proposed only." }));
// The old program's own runProgram over this branch's scripted bash model.
const oldDir = join(root, "old-fixture");
mkdirSync(oldDir);
symlinkSync(join(INSTALLED, "node_modules"), join(oldDir, "node_modules"));
const OLD = join(oldDir, "old-bash-program.ts");
writeFileSync(OLD, readFileSync(NEW, "utf8").replace('from "../../src/program.ts"', `from "${INSTALLED}/throughline/durable-agent/src/program.ts"`));

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
	const command = `node ${SHOW_ME} build ${spec} --transcript ${path} --words "${newest}" --out ${out} > ${out}.log 2>&1; echo "exit=$?"; grep -q "legacy Pi Durable" ${out}.log && echo "label=legacy"; grep -m1 -oE "agent isn.t running|current agent is not running|still starting" ${out}.log; if [ -f ${out} ]; then grep -q "picked from this thread" ${out} && echo "newest turn NOT found (picked)" || echo "newest turn found: ${newest}"; else echo "no page"; fi; echo "words=$(grep -oE '${WORDS}' ${out} 2>/dev/null | sort -u | tr '\\n' '|')"; true`;
	if (program === undefined) return execFileSync("bash", ["-c", command], { encoding: "utf8" }).replace(/\s+/g, " ").trim();
	await turn(program, `bash: ${command}`, `b${serial}`);
	return (await lastBash(program)).replace(/\s+/g, " ").trim();
};
const review = () =>
	execFileSync("bash", ["-c", `node ${SHOW_ME} review ${store} --out ${join(root, `review-${++serial}`)} > ${root}/review.log 2>&1; echo "exit=$?"; grep -m1 -oE "agent isn.t running|current agent is not running" ${root}/review.log; true`], { encoding: "utf8" })
		.replace(/\s+/g, " ")
		.trim();
const run = async (fixture: string, label: string, work: (program: AgentProgram) => Promise<void>, kill = false) => {
	const program = startProgram(process.execPath, [fixture, store, root]);
	await program.hello;
	console.log(`-- ${label}`);
	await work(program);
	if (kill) program.kill();
	else await program.call("drain");
	await program.exited;
};
const marked = () => existsSync(join(store, "owner-reads.v1"));

await run(OLD, "1. installed old agent program", async (program) => {
	await turn(program, "Old choice.", "a");
	console.log(`inside its turn: ${await build(program, join(store, "transcript.jsonl"), "Old choice.")}`);
	console.log(`from outside (never marked): ${await build(undefined, join(store, "transcript.jsonl"), "Old choice.")}`);
});
// Round 15 (Rereview14-1 #1, 14-3 #2): an upgrade that fails after its socket is serving leaves the old store read as today.
{
	const failing = startProgram(process.execPath, [NEW, store, root, join(root, "no-such-session.jsonl")]);
	await failing.hello.catch(() => undefined);
	await failing.exited;
	console.log(`-- 1b. upgrade attempt fails while carrying a missing file: marked ${marked()}; from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Old choice.")}`);
}
const before = readFileSync(join(store, "transcript.jsonl"), "utf8");
await run(
	NEW,
	"2. upgraded to this program; then killed (a crash)",
	async (program) => {
		await turn(program, "New decision after upgrade.", "b");
		console.log(`old skill body path (transcript.jsonl), inside the turn: ${await build(program, join(store, "transcript.jsonl"), "New decision after upgrade.")}`);
		console.log(`new prompt path (store folder), inside the turn: ${await build(program, store, "New decision after upgrade.")}`);
		await turn(program, "Withdrawn later.", "c");
		const withdrawn = (await entries(program)).find((e) => e.model?.[0]?.content === "Withdrawn later.");
		await program.call("forkBefore", { entryId: withdrawn?.id });
		await turn(program, "Replacement after rewind.", "d");
		console.log(`after a rewind, old body path: ${await build(program, join(store, "transcript.jsonl"), "Replacement after rewind.")}`);
		console.log(`transcript.jsonl byte-unchanged by the new program: ${readFileSync(join(store, "transcript.jsonl"), "utf8") === before}`);
	},
	true,
);
console.log(`after the crash, from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Replacement after rewind.")}`);
await run(NEW, "3. restarted after the crash; then a clean stop", async (program) => {
	await turn(program, "After the crash.", "e");
	console.log(`old body path, inside the turn: ${await build(program, join(store, "transcript.jsonl"), "After the crash.")}`);
});
console.log(`after a clean stop (marked ${marked()}, owner record ${existsSync(join(store, "owner.lock"))}): build from outside: ${await build(undefined, join(store, "transcript.jsonl"), "After the crash.")}; review from outside: ${review()}`);
await run(OLD, "4. rolled back to the installed old agent program, running", async (program) => {
	await turn(program, "Back on the old program.", "f");
	console.log(`inside its turn: ${await build(program, join(store, "transcript.jsonl"), "Back on the old program.")}`);
	console.log(`from outside while it runs: ${await build(undefined, join(store, "transcript.jsonl"), "Back on the old program.")}; review from outside: ${review()}`);
});
console.log(`5. rolled back, old program stopped (marked ${marked()}, owner record ${existsSync(join(store, "owner.lock"))}): build from outside: ${await build(undefined, join(store, "transcript.jsonl"), "Back on the old program.")}; review from outside: ${review()}`);
process.exit(0);
