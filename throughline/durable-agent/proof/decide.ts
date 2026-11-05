// Decide build 1's proof from results.json: exact facts in code first, then the JEV answers given on the command line
// against fixed thresholds. Writes Gate-Decision.json beside the results. A refusal names what it caught.
//   node proof/decide.ts <evidence dir> '<jev answers json>' <jev request id> <results sha256>
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Json = Record<string, any>;
const [dir, jevJson, requestId, sha] = process.argv.slice(2) as [string, string, string, string];
const results = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as Json;
const m = results.midAnswer;
const b = results.midBash;
const s = results.steerAndFollowUp;
const after = (entries: Json[], id: number) => entries.filter((e) => e.id > id);
const aborted = m.abortedAnswers as Json[];
const facts: Record<string, { ok: boolean; why: string }> = {
	abortedEntry: { ok: aborted.length === 1, why: "a model answer cut off by a kill must be kept as one aborted entry, or the partial is lost" },
	freshAnswer: {
		ok: aborted.length === 1 && after(m.entries, aborted[0].id).filter((e: Json) => e.role === "assistant" && e.stopReason === "stop").length === 1,
		why: "after restart the question must be answered once, fresh; zero means the work was lost, two means it ran twice",
	},
	bashOnceAfterFinish: { ok: m.bashResults === 1 && m.proofFileLines === 1, why: "a kill after bash finished must not run bash again" },
	bashInterrupted: {
		ok: b.bashStarts === 1 && b.toolResults.length === 1 && b.toolResults[0].isError === true && /interrupted/.test(b.toolResults[0].text),
		why: "a kill during bash must give the model an interrupted result and never start bash a second time",
	},
	secondRefused: { ok: m.secondProgram.exit === 3 && /STORE_ALREADY_OWNED/.test(m.secondProgram.refused), why: "two programs on one store would corrupt it" },
	transcriptAppendOnly: {
		ok: ["appendedOnly", "unique", "ordered", "complete"].every((k) => m.transcript[k] === true) && b.transcript.unique && b.transcript.complete,
		why: "transcript.jsonl must be one appended file holding every entry once, in order, or readers lose turns",
	},
	steerThenFollowUp: {
		ok: (() => {
			const e = s.entries as Json[];
			const steer = e.findIndex((x) => x.role === "user" && /PELICAN/.test(x.text));
			const answer = e.findIndex((x) => x.role === "assistant" && x.stopReason === "stop" && /PELICAN/.test(x.text));
			const follow = e.findIndex((x) => x.role === "user" && /FOLLOWUP/.test(x.text));
			const last = e.findIndex((x) => x.role === "assistant" && /^FOLLOWUP/.test(x.text));
			return s.settledQuestion === "done" && s.settledFollowUp === "done" && steer >= 0 && steer < answer && answer < follow && follow < last;
		})(),
		why: "a steer must land in the running answer and a follow-up must wait for the next run",
	},
};
const jev = JSON.parse(jevJson) as Record<string, { noul: number }>;
const THRESHOLD = 0.5;
const failedFacts = Object.entries(facts).filter(([, f]) => !f.ok);
const failedJev = Object.entries(jev).filter(([, a]) => a.noul < THRESHOLD);
const verdict = failedFacts.length > 0 || failedJev.length > 0 ? "block" : "approve";
const decision = {
	schema: "throughline.durable-build-1.proof-decision.v1",
	results_sha256: sha,
	jev: { model: "jev-1.14.0", request_id: requestId, threshold: THRESHOLD, answers: jev },
	facts,
	verdict,
	refusals: [
		...failedFacts.map(([k, f]) => `${k}: ${f.why}`),
		...failedJev.map(([k, a]) => `JEV ${k} answered ${a.noul}: the evidence does not support that part of map v3's proof`),
	],
};
await writeFile(join(dir, "Gate-Decision.json"), `${JSON.stringify(decision, null, 2)}\n`);
console.log(JSON.stringify({ verdict, refusals: decision.refusals }));
