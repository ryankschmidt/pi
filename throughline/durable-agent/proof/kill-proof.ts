// Build 1's proof, with a real model: kill the agent program mid-answer and mid-bash, start it again on the same
// store, and record what Pi Durable did. Map v3 section 9-5 says what should happen.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/kill-proof.ts <run dir> <evidence dir> [model]

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";

const [runDir, evidenceDir, model = "anthropic/claude-opus-5-5"] = process.argv.slice(2) as [string, string, string?];
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const log: string[] = [];
const note = (line: string) => {
	const stamped = `${new Date().toISOString()} ${line}`;
	log.push(stamped);
	process.stdout.write(`${stamped}\n`);
};

type Json = Record<string, any>;
type Program = AgentProgram & { view: Json | undefined; views: number; name: string };

async function launch(name: string, store: string, cwd: string): Promise<Program> {
	await mkdir(cwd, { recursive: true });
	const program = startProgram(
		process.execPath,
		[main, "--store", store, "--agent", name, "--cwd", cwd, "--model", model],
		{ env: process.env },
	) as Program;
	program.name = name;
	program.views = 0;
	const hello = await program.hello;
	note(`${name}: started pid ${hello.pid}, protocol ${hello.protocol}, ${hello.engine} ${hello.version}, conversation ${hello.conversationId}`);
	program.onView((view) => {
		program.view = view.value as Json;
		program.views++;
	});
	await program.call("watch");
	return program;
}

async function until(program: Program, what: string, test: (view: Json) => boolean, timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (program.view && test(program.view)) return;
		const failure = program.view?.docs?.["pi.live"]?.runFailure;
		if (failure) throw new Error(`run failed while waiting for ${what}: ${JSON.stringify(failure).slice(0, 600)}`);
		await new Promise((r) => setTimeout(r, 50));
	}
	const view = program.view;
	throw new Error(
		`timed out waiting for ${what}: ${program.views} views; entries ${JSON.stringify((view?.entries ?? []).map((e: Json) => e.kind))}; live ${JSON.stringify(view ? live(view) : null).slice(0, 800)}`,
	);
}

const live = (view: Json) => (view.docs?.["pi.live"] ?? {}) as Json;
const partialText = (view: Json) =>
	((live(view).generation?.message?.content ?? []) as Json[])
		.filter((c) => c.type === "text")
		.map((c) => String(c.text))
		.join("");
const hasEntry = (view: Json, kind: string) => (view.entries as Json[]).some((e) => e.kind === kind);

async function allEntries(program: Program): Promise<Json[]> {
	const page = (await program.call("entries", { limit: 1000, order: "ascending" })) as { items: Json[] };
	return page.items;
}

/** One line per entry: kind, and for messages their role, stop reason, error flag and text. */
function describe(entries: Json[]) {
	return entries.map((entry) => {
		const message = (entry.model ?? [])[0] as Json | undefined;
		const content = message?.content ?? [];
		const text = (typeof content === "string" ? [{ type: "text", text: content }] : (content as Json[]))
			.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[toolCall ${c.name} ${JSON.stringify(c.arguments)}]` : `[${c.type}]`))
			.join(" ");
		return {
			id: entry.id,
			conversationId: entry.conversationId,
			kind: entry.kind,
			role: message?.role,
			stopReason: message?.stopReason,
			isError: message?.isError,
			chars: text.length,
			text: text.length > 240 ? `${text.slice(0, 160)} … ${text.slice(-60)}` : text,
		};
	});
}

async function transcriptLines(store: string) {
	const text = await readFile(join(store, "transcript.jsonl"), "utf8");
	return { text, lines: text.trim().split("\n").map((l) => JSON.parse(l) as Json) };
}

function checkTranscript(lines: Json[], entries: Json[]) {
	const ids = lines.filter((l) => l.entry).map((l) => Number(l.entry.id));
	const unique = new Set(ids).size === ids.length;
	const ordered = ids.every((id, i) => i === 0 || id > ids[i - 1]!);
	const storeIds = entries.map((e) => Number(e.id));
	const complete = storeIds.every((id) => ids.includes(id));
	return { entryLines: ids.length, conversationLines: lines.filter((l) => l.conversation).length, unique, ordered, complete };
}

const results: Json = { model, startedAt: new Date().toISOString() };

// ── 1. Kill mid-answer, after bash finished ───────────────────────────────────────────────────────────
{
	const store = join(runDir, "s1-store");
	const cwd = join(runDir, "s1-cwd");
	const first = await launch("proof-mid-answer", store, cwd);
	// The broker answers a request that carries a tool result in one burst, so the answer after bash has no
	// mid-stream moment to cut. Bash runs to completion in its own run; the next run's long answer is cut.
	const bash = (await first.call("submit", {
		requestId: "s1-bash",
		content: "Use the bash tool exactly once to run: echo answer-proof >> proof.txt\nThen reply with the single word: ok",
	})) as { submissionId: number };
	const bashSettled = (await first.call("wait", { submissionId: bash.submissionId })) as Json;
	note(`s1: bash run settled ${bashSettled.status}`);
	const { submissionId } = (await first.call("submit", {
		requestId: "s1-question",
		content:
			"Without using any tool, write a long answer: count from 1 to 150, one number per line, each followed by one English word.",
	})) as { submissionId: number };
	note(`s1: submitted ${submissionId}`);
	await until(first, "bash result and a streaming answer", (v) => hasEntry(v, "pi.tool-result") && partialText(v).length > 400);
	note(`s1: bash finished; answer streaming, ${partialText(first.view!).length} chars shown`);
	// While the first program runs, a second one on the same store must be refused.
	const second = startProgram(process.execPath, [main, "--store", store, "--agent", "proof-mid-answer", "--cwd", cwd, "--model", model], { env: process.env });
	const refused = await second.hello.then(
		() => "started (WRONG)",
		(error: Error) => error.message,
	);
	const secondExit = await second.exited;
	note(`s1: second program on the same store: ${refused}, exit ${secondExit}`);
	await new Promise((r) => setTimeout(r, 1500)); // let at least one deferred partial commit reach storage
	const shownBeforeKill = partialText(first.view!).length;
	first.kill();
	const killedExit = await first.exited;
	note(`s1: killed mid-answer (exit ${killedExit}); ${shownBeforeKill} chars had been shown`);
	const before = await transcriptLines(store);
	const restarted = await launch("proof-mid-answer", store, cwd);
	const settled = (await restarted.call("wait", { submissionId })) as Json;
	note(`s1: after restart the question settled: ${settled.status}`);
	const entries = await allEntries(restarted);
	await restarted.call("drain");
	await restarted.exited;
	const after = await transcriptLines(store);
	const proofFile = existsSync(join(cwd, "proof.txt")) ? await readFile(join(cwd, "proof.txt"), "utf8") : "";
	const described = describe(entries);
	const assistants = described.filter((e) => e.role === "assistant");
	results.midAnswer = {
		secondProgram: { refused, exit: secondExit },
		killedExit,
		charsShownBeforeKill: shownBeforeKill,
		settled: settled.status,
		entries: described,
		abortedAnswers: assistants.filter((e) => e.stopReason === "aborted").map((e) => ({ id: e.id, chars: e.chars })),
		completedAnswers: assistants.filter((e) => e.stopReason === "stop").map((e) => ({ id: e.id, chars: e.chars })),
		bashResults: described.filter((e) => e.kind === "pi.tool-result").length,
		proofFileLines: proofFile.split("\n").filter((l) => l === "answer-proof").length,
		transcript: {
			bytesBeforeRestart: before.text.length,
			bytesAfter: after.text.length,
			appendedOnly: after.text.startsWith(before.text),
			...checkTranscript(after.lines, entries),
		},
	};
	await copyFile(join(store, "transcript.jsonl"), join(evidenceDir, "s1-transcript.jsonl"));
	await writeFile(join(evidenceDir, "s1-stderr-first.txt"), first.stderr());
	await writeFile(join(evidenceDir, "s1-stderr-restarted.txt"), restarted.stderr());
}

// ── 2. Kill during bash ──────────────────────────────────────────────────────────────────────────────
{
	const store = join(runDir, "s2-store");
	const cwd = join(runDir, "s2-cwd");
	const first = await launch("proof-mid-bash", store, cwd);
	const { submissionId } = (await first.call("submit", {
		requestId: "s2-question",
		content:
			"Use the bash tool exactly once to run: echo start-$$ >> proof.txt; sleep 15; echo end-$$ >> proof.txt\nThen reply in one short sentence saying what the tool result said. Do not run the command again whatever the result.",
	})) as { submissionId: number };
	note(`s2: submitted ${submissionId}`);
	const started = Date.now();
	while (!(existsSync(join(cwd, "proof.txt")) && (await readFile(join(cwd, "proof.txt"), "utf8")).includes("start-"))) {
		if (Date.now() - started > 180_000) throw new Error("bash never started");
		await new Promise((r) => setTimeout(r, 100));
	}
	await new Promise((r) => setTimeout(r, 1500));
	first.kill();
	const killedExit = await first.exited;
	note(`s2: killed during bash (exit ${killedExit})`);
	const restarted = await launch("proof-mid-bash", store, cwd);
	const settled = (await restarted.call("wait", { submissionId })) as Json;
	note(`s2: after restart the question settled: ${settled.status}`);
	const entries = await allEntries(restarted);
	await restarted.call("drain");
	await restarted.exited;
	// The killed program's shell keeps running its sleep; wait it out to see every line it writes.
	await new Promise((r) => setTimeout(r, 16_000));
	const proofFile = await readFile(join(cwd, "proof.txt"), "utf8");
	const described = describe(entries);
	const after = await transcriptLines(store);
	results.midBash = {
		killedExit,
		settled: settled.status,
		entries: described,
		toolResults: described.filter((e) => e.kind === "pi.tool-result"),
		bashStarts: proofFile.split("\n").filter((l) => l.startsWith("start-")).length,
		bashEnds: proofFile.split("\n").filter((l) => l.startsWith("end-")).length,
		proofFile,
		transcript: checkTranscript(after.lines, entries),
	};
	await copyFile(join(store, "transcript.jsonl"), join(evidenceDir, "s2-transcript.jsonl"));
	await writeFile(join(evidenceDir, "s2-stderr-restarted.txt"), restarted.stderr());
}

// ── 3. Steer and follow-up while busy ────────────────────────────────────────────────────────────────
{
	const store = join(runDir, "s3-store");
	const cwd = join(runDir, "s3-cwd");
	const program = await launch("proof-steer", store, cwd);
	const q = (await program.call("submit", {
		requestId: "s3-question",
		content: "Use the bash tool once to run: sleep 8; echo s3-done\nThen answer in one sentence.",
	})) as { submissionId: number };
	await until(program, "the bash call running", (v) => Array.isArray(live(v).tools) && live(v).tools.length > 0);
	const steer = (await program.call("submit", {
		requestId: "s3-steer",
		content: "Also include the word PELICAN in your answer.",
		whenBusy: "steer",
		whenIdle: "reject",
	})) as { submissionId: number };
	const follow = (await program.call("submit", {
		requestId: "s3-follow",
		content: "Now reply with only the word FOLLOWUP.",
	})) as { submissionId: number };
	const inbox = program.view?.docs?.["pi.inbox"];
	await new Promise((r) => setTimeout(r, 300));
	const inboxWhileBusy = program.view?.docs?.["pi.inbox"] ?? inbox;
	note(`s3: steer ${steer.submissionId} and follow-up ${follow.submissionId} submitted while busy`);
	const settledQ = (await program.call("wait", { submissionId: q.submissionId })) as Json;
	const settledF = (await program.call("wait", { submissionId: follow.submissionId })) as Json;
	const entries = describe(await allEntries(program));
	await program.call("drain");
	await program.exited;
	results.steerAndFollowUp = {
		settledQuestion: settledQ.status,
		settledFollowUp: settledF.status,
		inboxWhileBusy,
		entries,
	};
}

results.finishedAt = new Date().toISOString();
await writeFile(join(evidenceDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await writeFile(join(evidenceDir, "run-log.txt"), `${log.join("\n")}\n`);
note(`results written to ${join(evidenceDir, "results.json")}`);
