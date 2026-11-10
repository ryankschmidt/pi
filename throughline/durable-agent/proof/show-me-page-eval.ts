// Real-model eval of a whole /show-me run (Rereview3-2 #3): past the first answer, until the model publishes a page or
// gives up. The real agent program with Ryan's Pi agent folder and the pinned show-me, real models through the tower
// broker, a fresh store per run. ThroughLine's html_render tool is supplied and recorded here; every other tool is the
// agent's own. The thread first states a decision in plain words, then Ryan types the command.
//   node proof/show-me-page-eval.ts --out <results.json> [--runs 10] [--models a,b] [--parallel 4]
// Per run it records: the command turn's first tool call; whether show-me's build and check commands ran and succeeded;
// whether html_render received a page show-me built (it carries <meta name="show-me-words">); the words line the page
// quotes; the time taken. The run is stopped after the first html_render or after 15 minutes.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SHIPPED_SHOW_ME } from "../install/runtime.ts";
import { type AgentProgram, startProgram } from "../src/client.ts";

const { values } = parseArgs({
	options: {
		out: { type: "string" },
		runs: { type: "string", default: "10" },
		models: { type: "string", default: "anthropic/claude-opus-5-5,openai-codex/gpt-6.1-terra" },
		parallel: { type: "string", default: "4" },
	},
});
if (!values.out) throw new Error("usage: show-me-page-eval.ts --out <results.json>");
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONTEXT =
	"We need to pick how the build caches results: a Redis service, an in-process LRU cache, or no cache. I lean toward the in-process LRU because it adds no service to run. Just acknowledge this in one line for now.";
const COMMAND = "/show-me the choice of build cache";
const HTML_RENDER = {
	name: "html_render",
	description: "Show an HTML page inline in Ryan's ThroughLine thread.",
	inputSchema: { type: "object", properties: { html: { type: "string" }, title: { type: "string" }, height: { type: "number" } }, required: ["html"] },
};
const RUN_LIMIT_MS = 15 * 60_000;

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
	Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);

function layout() {
	const root = mkdtempSync(join(tmpdir(), "show-me-page-eval-"));
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
	writeFileSync(join(root, "tools.json"), JSON.stringify([HTML_RENDER]));
	return { programDir, root, showMe: realpathSync(showMe) };
}

async function turn(program: AgentProgram, content: string, id: string, ms: number) {
	const { submissionId } = (await program.call("submit", { content, requestId: id })) as { submissionId: number };
	return (await within(program.call("wait", { submissionId }), ms, `turn ${id} did not settle`)) as { status: string };
}

type Stored = { id: number; kind: string; model?: { role: string; content: unknown; toolCallId?: string; isError?: boolean }[] };
async function run(model: string, index: number) {
	const { programDir, root, showMe } = layout();
	const program = startProgram(
		process.execPath,
		[join(programDir, "src/main.ts"), "--store", join(root, "store"), "--agent", "eval", "--cwd", join(root, "work"), "--model", model, "--runtime-mode", "full-access", "--tools", join(root, "tools.json")],
		{},
	);
	const renders: { html: string; title?: string }[] = [];
	let published: () => void = () => {};
	const publishedOnce = new Promise<void>((resolve) => {
		published = resolve;
	});
	program.onToolCall((call) => {
		const args = (call.arguments ?? {}) as { html?: string; title?: string };
		if (call.name === "html_render") {
			renders.push({ html: String(args.html ?? ""), ...(args.title ? { title: args.title } : {}) });
			program.answerTool(call.id, { content: [{ type: "text", text: "The page is shown in the thread." }] });
			published();
		} else program.answerTool(call.id, { content: [{ type: "text", text: `${call.name} is not available in this run` }], isError: true });
	});
	const started = Date.now();
	let error: string | undefined;
	let commandFrom = 0;
	try {
		await within(program.hello, 60_000, "no hello");
		await turn(program, CONTEXT, "context", 5 * 60_000);
		commandFrom = entries(root).at(-1)?.id ?? 0;
		const { submissionId } = (await program.call("submit", { content: COMMAND, requestId: "command" })) as { submissionId: number };
		await Promise.race([program.call("wait", { submissionId }), publishedOnce, new Promise((resolve) => setTimeout(resolve, RUN_LIMIT_MS))]);
		await within(program.call("abort"), 10_000, "abort").catch(() => undefined);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		program.kill();
	}
	// Read what the run did from its own stored entries.
	const stored = entries(root).filter((entry) => entry.id > commandFrom);
	const calls = stored.flatMap((entry) =>
		entry.kind === "pi.assistant"
			? ((entry.model?.[0]?.content ?? []) as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]).filter((part) => part.type === "toolCall")
			: [],
	);
	const result = (id: string | undefined) =>
		stored.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId === id)?.model?.[0];
	const bashOf = (pattern: RegExp) => calls.filter((call) => call.name === "bash" && pattern.test(String(call.arguments?.command ?? "")));
	const succeeded = (list: typeof calls) => list.some((call) => result(call.id)?.isError !== true && !/exit code [1-9]|Error:/.test(JSON.stringify(result(call.id)?.content ?? "")));
	const builds = bashOf(/show-me\/dist\/cli\.js build/);
	const checks = bashOf(/show-me\/dist\/cli\.js check/);
	const page = renders.find((render) => render.html.includes('name="show-me-words"'));
	// The page records its words line as base64 JSON {text, time, picked}: picked means not found among the user's turns.
	const encoded = page ? /<meta name="show-me-words" content="([^"]*)"/.exec(page.html)?.[1] : undefined;
	const words = encoded ? (JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { text: string; picked: boolean }) : null;
	const first = calls[0];
	return {
		model,
		run: index,
		first_tool: first ? { name: first.name, path: first.arguments?.path ?? null } : null,
		read_skill_first: first?.name === "read" && typeof first.arguments?.path === "string" && existsSync(first.arguments.path as string) && realpathSync(first.arguments.path as string) === showMe,
		build_ran: builds.length > 0,
		build_succeeded: succeeded(builds),
		check_ran: checks.length > 0,
		check_succeeded: succeeded(checks),
		html_render_calls: renders.length,
		published_show_me_page: page !== undefined,
		words_from_user_turn: words !== null && words.picked === false && CONTEXT.includes(words.text),
		page_words: words,
		tool_calls: calls.length,
		seconds: Math.round((Date.now() - started) / 1000),
		error: error ?? null,
		stderr_tail: program.stderr().slice(-300),
	};
}

function entries(root: string): Stored[] {
	const file = join(root, "store/transcript.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				const entry = (JSON.parse(line) as { entry?: Stored }).entry;
				return entry ? [entry] : [];
			} catch {
				return [];
			}
		});
}

const jobs: (() => ReturnType<typeof run>)[] = [];
for (const model of (values.models as string).split(",")) for (let i = 0; i < Number(values.runs); i++) jobs.push(() => run(model, i));
const results: Awaited<ReturnType<typeof run>>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Number(values.parallel) }, async () => {
		while (next < jobs.length) {
			const result = await (jobs[next++] as () => ReturnType<typeof run>)();
			results.push(result);
			process.stdout.write(
				`${result.published_show_me_page ? "PAGE" : "NO-PAGE"} ${result.model} #${result.run} read-first=${result.read_skill_first} build=${result.build_ran}/${result.build_succeeded} check=${result.check_ran}/${result.check_succeeded} renders=${result.html_render_calls} ${result.seconds}s${result.error ? ` ${result.error}` : ""}\n`,
			);
		}
	}),
);
const count = (model: string, key: keyof (typeof results)[number]) => `${results.filter((r) => r.model === model && r[key] === true).length}/${results.filter((r) => r.model === model).length}`;
const summary = Object.fromEntries(
	[...new Set(results.map((r) => r.model))].map((model) => [
		model,
		{ read_skill_first: count(model, "read_skill_first"), build_succeeded: count(model, "build_succeeded"), check_ran: count(model, "check_ran"), published_show_me_page: count(model, "published_show_me_page"), words_from_user_turn: count(model, "words_from_user_turn") },
	]),
);
writeFileSync(values.out as string, `${JSON.stringify({ schema: "durable-agent.show-me-page-eval.v1", ran_at: new Date().toISOString(), context: CONTEXT, command: COMMAND, summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
// A killed agent's detached children can keep the event loop alive; the results are written, so end here.
process.exit(0);
