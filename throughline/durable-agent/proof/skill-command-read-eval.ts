// Real-model eval of the skill-command rule (Design-Judgment-2, test 8): the real agent program with Ryan's Pi agent
// folder and the pinned show-me, against real models through the tower broker. Each run is a fresh store. Pass: every
// command run's first tool call is `read` on the command's listed file; the plain message triggers no read.
//   node proof/skill-command-read-eval.ts --out <results.json> [--runs 10] [--models anthropic/claude-opus-5-5,openai-codex/gpt-6.1-terra]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SHIPPED_SHOW_ME } from "../install/runtime.ts";
import { startProgram } from "../src/client.ts";

const { values } = parseArgs({
	options: {
		out: { type: "string" },
		runs: { type: "string", default: "10" },
		models: { type: "string", default: "anthropic/claude-opus-5-5,openai-codex/gpt-6.1-terra" },
		parallel: { type: "string", default: "4" },
	},
});
if (!values.out) throw new Error("usage: skill-command-read-eval.ts --out <results.json>");
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));

// A model-callable skill from Ryan's own skill list, for the `/skill:<name>` case.
const settings = SettingsManager.create(process.cwd());
const callable = loadSkills({ cwd: process.cwd(), agentDir: getAgentDir(), skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills.find(
	(skill) => !skill.disableModelInvocation && skill.name === "message-optimizer",
);
if (!callable) throw new Error("message-optimizer is not in pi's skills; pick another model-callable skill");

type Case = { id: string; text: string; expect: "read-show-me" | "read-callable" | "no-read" };
const CASES: Case[] = [
	{ id: "show-me-args", text: "/show-me the next step", expect: "read-show-me" },
	{ id: "skill-show-me", text: "/skill:show-me", expect: "read-show-me" },
	{ id: "skill-callable", text: `/skill:${callable.name} go`, expect: "read-callable" },
	{ id: "plain-mention", text: "I liked the show-me page you made earlier. Reply with just the word thanks.", expect: "no-read" },
];

function layout(): { programDir: string; root: string; showMe: string } {
	const root = mkdtempSync(join(tmpdir(), "skill-eval-"));
	const programDir = join(root, "throughline/durable-agent");
	cpSync(join(AGENT_DIR, "src"), join(programDir, "src"), { recursive: true });
	cpSync(join(AGENT_DIR, "package.json"), join(programDir, "package.json"));
	const showMe = join(programDir, "capabilities/skills/show-me/SKILL.md");
	mkdirSync(dirname(showMe), { recursive: true });
	cpSync(SHIPPED_SHOW_ME, showMe);
	let up = AGENT_DIR;
	while (!existsSync(join(up, "node_modules/@earendil-works/pi-durable"))) up = dirname(up);
	symlinkSync(join(up, "node_modules"), join(root, "node_modules"));
	mkdirSync(join(root, "work"));
	return { programDir, root, showMe: realpathSync(showMe) };
}

type ToolCall = { name: string; path?: string };
// Every wait on the program is bounded, so one stuck run cannot hold the whole eval.
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
	Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);
async function run(model: string, testCase: Case, index: number) {
	const { programDir, root, showMe } = layout();
	const program = startProgram(process.execPath, [join(programDir, "src/main.ts"), "--store", join(root, "store"), "--agent", "eval", "--cwd", join(root, "work"), "--model", model], {});
	const started = Date.now();
	let first: ToolCall | null | undefined;
	let error: string | undefined;
	try {
		await within(program.hello, 60_000, "no hello within 60 s");
		const { submissionId } = (await program.call("submit", { content: testCase.text, requestId: `e${index}` })) as { submissionId: number };
		const settled = program.call("wait", { submissionId });
		// The first stored answer decides: its first tool call, or none. Stop the run there to keep runs short.
		while (first === undefined && Date.now() - started < 240_000) {
			await new Promise((resolve) => setTimeout(resolve, 400));
			const file = join(root, "store/transcript.jsonl");
			if (!existsSync(file)) continue;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				let entry: { kind?: string; model?: { content?: unknown }[] } | undefined;
				try {
					entry = (JSON.parse(line) as { entry?: typeof entry }).entry;
				} catch {
					continue;
				}
				if (entry?.kind !== "pi.assistant") continue;
				const content = (entry.model?.[0]?.content ?? []) as { type: string; name?: string; arguments?: { path?: string } }[];
				const call = content.find((part) => part.type === "toolCall");
				first = call ? { name: call.name ?? "", ...(call.arguments?.path ? { path: call.arguments.path } : {}) } : null;
				break;
			}
		}
		await within(program.call("abort"), 10_000, "abort").catch(() => undefined);
		await Promise.race([settled.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		program.kill();
	}
	const expected = testCase.expect === "read-show-me" ? showMe : testCase.expect === "read-callable" ? realpathSync(callable!.filePath) : undefined;
	const readPath = first?.name === "read" && first.path ? (existsSync(first.path) ? realpathSync(first.path) : first.path) : undefined;
	const pass = error === undefined && first !== undefined && (testCase.expect === "no-read" ? first?.name !== "read" : readPath === expected);
	return { model, case: testCase.id, run: index, first: first ?? null, expected: expected ?? null, pass, error: error ?? (first === undefined ? "no answer within 240 s" : undefined), seconds: Math.round((Date.now() - started) / 1000), stderr_tail: program.stderr().slice(-400) };
}

const jobs: (() => ReturnType<typeof run>)[] = [];
for (const model of (values.models as string).split(",")) for (const testCase of CASES) for (let i = 0; i < Number(values.runs); i++) jobs.push(() => run(model, testCase, i));
const results: Awaited<ReturnType<typeof run>>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Number(values.parallel) }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++] as () => ReturnType<typeof run>;
			const result = await job();
			results.push(result);
			process.stdout.write(`${result.pass ? "PASS" : "FAIL"} ${result.model} ${result.case} #${result.run} ${JSON.stringify(result.first)}${result.error ? ` ${result.error}` : ""}\n`);
		}
	}),
);
const summary = Object.fromEntries(
	[...new Set(results.map((r) => `${r.model} ${r.case}`))].map((key) => [key, `${results.filter((r) => `${r.model} ${r.case}` === key && r.pass).length}/${results.filter((r) => `${r.model} ${r.case}` === key).length}`]),
);
writeFileSync(values.out as string, `${JSON.stringify({ schema: "durable-agent.skill-command-read-eval.v1", ran_at: new Date().toISOString(), cases: CASES, summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
