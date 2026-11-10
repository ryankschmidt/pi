// Real-model eval of a whole /show-me run (Rereview3-2 #3, Rereview4-2 #2): past the first answer, until the model
// publishes a page or gives up. The real agent program with Ryan's Pi agent folder and the pinned show-me, real models
// through the tower broker, a fresh store per run. ThroughLine's html_render_file and html_render are supplied and
// recorded here (html_render_file refuses bytes whose SHA-256 differs, as ThroughLine's does); every other tool is the
// agent's own. The thread first states a decision in plain words, then Ryan types the command. One extra run per model
// is a rewound thread: the withdrawn turn holds the most on-topic sentence, and the page must never quote it.
//   node proof/show-me-page-eval.ts --out <results.json> [--runs 10] [--models a,b] [--parallel 4]
// A run passes only when: conversation_snapshot ran before build and build's --transcript is the path it returned;
// build and check each have a stored, successful result; the bytes published through html_render_file hash to the
// passing check's publish sha256; and no plain html_render call was made. A missing result is a failure.
import { createHash } from "node:crypto";
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
// The rewound case: this turn is withdrawn by a rewind before the command, so its sentence must never be the words line.
const WITHDRAWN = "Decision on the build cache: use the Redis service for build caching, it is the cache we pick. Just acknowledge this in one line.";
const HTML_RENDER = {
	name: "html_render",
	description: "Show an HTML page inline in Ryan's ThroughLine thread.",
	inputSchema: { type: "object", properties: { html: { type: "string" }, title: { type: "string" }, height: { type: "number" } }, required: ["html"] },
};
const HTML_RENDER_FILE = {
	name: "html_render_file",
	description: "Show a checked HTML page file inline in this thread if its bytes hash to sha256. Pass the publish fields of a passing show-me check.",
	inputSchema: {
		type: "object",
		properties: { file: { type: "string" }, sha256: { type: "string" }, title: { type: "string" }, height: { type: "integer" } },
		required: ["file", "sha256", "title", "height"],
	},
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
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
	writeFileSync(join(root, "tools.json"), JSON.stringify([HTML_RENDER_FILE, HTML_RENDER]));
	return { programDir, root, showMe: realpathSync(showMe) };
}

async function turn(program: AgentProgram, content: string, id: string, ms: number) {
	const { submissionId } = (await program.call("submit", { content, requestId: id })) as { submissionId: number };
	return (await within(program.call("wait", { submissionId }), ms, `turn ${id} did not settle`)) as { status: string };
}

type Stored = { id: number; kind: string; model?: { role: string; content: unknown; toolCallId?: string; isError?: boolean }[] };
async function run(model: string, index: number, rewound: boolean) {
	const { programDir, root, showMe } = layout();
	const program = startProgram(
		process.execPath,
		[join(programDir, "src/main.ts"), "--store", join(root, "store"), "--agent", "eval", "--cwd", join(root, "work"), "--model", model, "--runtime-mode", "full-access", "--tools", join(root, "tools.json")],
		{},
	);
	const renders: { html: string; title?: string }[] = [];
	const fileRenders: { file: string; sha256: string; html: string | null; refused: boolean }[] = [];
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
		} else if (call.name === "html_render_file") {
			const fileArgs = (call.arguments ?? {}) as { file?: string; sha256?: string };
			let html: string | null = null;
			try {
				html = readFileSync(String(fileArgs.file), "utf8");
			} catch {}
			const refused = html === null || sha256(html) !== fileArgs.sha256;
			fileRenders.push({ file: String(fileArgs.file), sha256: String(fileArgs.sha256), html, refused });
			if (refused) program.answerTool(call.id, { content: [{ type: "text", text: "Refused: the page file's bytes do not match sha256." }], isError: true });
			else {
				program.answerTool(call.id, { content: [{ type: "text", text: "Shown to the reader above your reply." }] });
				published();
			}
		} else program.answerTool(call.id, { content: [{ type: "text", text: `${call.name} is not available in this run` }], isError: true });
	});
	const started = Date.now();
	let error: string | undefined;
	let commandFrom = 0;
	try {
		await within(program.hello, 60_000, "no hello");
		await turn(program, CONTEXT, "context", 5 * 60_000);
		if (rewound) {
			await turn(program, WITHDRAWN, "withdrawn", 5 * 60_000);
			const withdrawn = (await entries(program)).find((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("Redis service for build caching"));
			if (withdrawn === undefined) throw new Error("the withdrawn turn was not stored");
			await program.call("forkBefore", { entryId: withdrawn.id });
		}
		commandFrom = (await entries(program)).at(-1)?.id ?? 0;
		const { submissionId } = (await program.call("submit", { content: COMMAND, requestId: "command" })) as { submissionId: number };
		await Promise.race([program.call("wait", { submissionId }), publishedOnce, new Promise((resolve) => setTimeout(resolve, RUN_LIMIT_MS))]);
		await within(program.call("abort"), 10_000, "abort").catch(() => undefined);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	// Read what the run did from its own stored entries, through the program's entries call, before stopping it.
	const stored = (await entries(program).catch(() => [] as Stored[])).filter((entry) => entry.id > commandFrom);
	program.kill();
	const calls = stored.flatMap((entry) =>
		entry.kind === "pi.assistant"
			? ((entry.model?.[0]?.content ?? []) as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]).filter((part) => part.type === "toolCall")
			: [],
	);
	const result = (id: string | undefined) =>
		stored.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId === id)?.model?.[0];
	const bashOf = (pattern: RegExp) => calls.filter((call) => call.name === "bash" && pattern.test(String(call.arguments?.command ?? "")));
	// A call counts only with a stored result that is not an error and shows no failed exit.
	const ok = (call: (typeof calls)[number]) => {
		const answer = result(call.id);
		return answer !== undefined && answer.isError !== true && !/exit code [1-9]|Error:/.test(JSON.stringify(answer.content ?? ""));
	};
	const succeeded = (list: typeof calls) => list.length > 0 && list.every(ok);
	const textOf = (call: (typeof calls)[number] | undefined) => JSON.stringify(result(call?.id)?.content ?? "");
	const builds = bashOf(/show-me\/dist\/cli\.js build/);
	const checks = bashOf(/show-me\/dist\/cli\.js check/);
	const snapshots = calls.filter((call) => call.name === "conversation_snapshot");
	const snapshotPath = /(\/[^"\\]*\/snapshots\/\d+-\d+\.jsonl)/.exec(textOf(snapshots.at(-1)))?.[1];
	const buildIndex = calls.findIndex((call) => builds.includes(call));
	const snapshotBeforeBuild = snapshots.length > 0 && calls.indexOf(snapshots[0] as (typeof calls)[number]) < buildIndex;
	const transcriptArg = /--transcript\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(String(builds.at(-1)?.arguments?.command ?? ""));
	const buildTranscript = transcriptArg?.[2] ?? transcriptArg?.[3] ?? transcriptArg?.[4];
	const checkSha = /\\?"publish\\?":\s*\{[^}]*?\\?"sha256\\?":\s*\\?"([0-9a-f]{64})/.exec(textOf(checks.at(-1)))?.[1];
	const shown = fileRenders.filter((render) => !render.refused);
	const published_checked_bytes = checkSha !== undefined && shown.length > 0 && shown.every((render) => render.html !== null && sha256(render.html) === checkSha);
	const page = shown.at(-1) ? { html: shown.at(-1)?.html ?? "" } : undefined;
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
		rewound,
		snapshot_before_build: snapshotBeforeBuild,
		build_transcript_is_snapshot: snapshotPath !== undefined && buildTranscript === snapshotPath,
		html_render_calls: renders.length,
		html_render_file_calls: fileRenders.length,
		html_render_file_refused: fileRenders.filter((render) => render.refused).length,
		published_checked_bytes,
		passed:
			snapshotBeforeBuild && snapshotPath !== undefined && buildTranscript === snapshotPath && succeeded(builds) && succeeded(checks) && published_checked_bytes && renders.length === 0,
		words_from_user_turn: words !== null && words.picked === false && CONTEXT.includes(words.text),
		words_never_withdrawn: words === null || !WITHDRAWN.includes(words.text),
		page_words: words,
		tool_calls: calls.length,
		seconds: Math.round((Date.now() - started) / 1000),
		error: error ?? null,
		stderr_tail: program.stderr().slice(-300),
	};
}

/** Every entry the bound conversation shows, through the program's own entries call. */
async function entries(program: AgentProgram): Promise<Stored[]> {
	const all: Stored[] = [];
	let cursor: unknown;
	do {
		const page = (await within(program.call("entries", { limit: 100, ...(cursor === undefined ? {} : { cursor }) }), 30_000, "entries")) as { items: Stored[]; next?: unknown };
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined && cursor !== null);
	return all;
}

const jobs: (() => ReturnType<typeof run>)[] = [];
for (const model of (values.models as string).split(",")) {
	for (let i = 0; i < Number(values.runs); i++) jobs.push(() => run(model, i, false));
	jobs.push(() => run(model, Number(values.runs), true));
}
const results: Awaited<ReturnType<typeof run>>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Number(values.parallel) }, async () => {
		while (next < jobs.length) {
			const result = await (jobs[next++] as () => ReturnType<typeof run>)();
			results.push(result);
			process.stdout.write(
				`${result.passed ? "PASS" : "FAIL"} ${result.model} #${result.run}${result.rewound ? " rewound" : ""} snapshot=${result.snapshot_before_build}/${result.build_transcript_is_snapshot} build=${result.build_succeeded} check=${result.check_succeeded} checked-bytes=${result.published_checked_bytes} file-renders=${result.html_render_file_calls}(refused ${result.html_render_file_refused}) plain-renders=${result.html_render_calls} words-not-withdrawn=${result.words_never_withdrawn} ${result.seconds}s${result.error ? ` ${result.error}` : ""}\n`,
			);
		}
	}),
);
const count = (model: string, key: keyof (typeof results)[number]) => `${results.filter((r) => r.model === model && r[key] === true).length}/${results.filter((r) => r.model === model).length}`;
const summary = Object.fromEntries(
	[...new Set(results.map((r) => r.model))].map((model) => [
		model,
		{ passed: count(model, "passed"), read_skill_first: count(model, "read_skill_first"), snapshot_before_build: count(model, "snapshot_before_build"), build_transcript_is_snapshot: count(model, "build_transcript_is_snapshot"), build_succeeded: count(model, "build_succeeded"), check_succeeded: count(model, "check_succeeded"), published_checked_bytes: count(model, "published_checked_bytes"), words_never_withdrawn: count(model, "words_never_withdrawn") },
	]),
);
writeFileSync(values.out as string, `${JSON.stringify({ schema: "durable-agent.show-me-page-eval.v2", ran_at: new Date().toISOString(), context: CONTEXT, command: COMMAND, summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
// A killed agent's detached children can keep the event loop alive; the results are written, so end here.
process.exit(0);
