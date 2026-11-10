// The /show-me evaluation's verdict (Rereview8-2 #2): a rewound run whose page quotes the withdrawn sentence, or a page
// with no words line, must fail even when every other step succeeded, and any failed run must fail the evaluation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCode, type RunFacts, scoreRun } from "../proof/show-me-score.ts";

const retained = "We need to pick how the build caches results. I lean toward the in-process LRU because it adds no service to run.";
const withdrawn = "Decision on the build cache: use the Redis service for build caching, it is the cache we pick.";
const good: RunFacts = {
	snapshotBeforeBuild: true,
	buildTranscriptIsSnapshot: true,
	buildSucceeded: true,
	checkSucceeded: true,
	publishedCheckedBytes: true,
	rewound: true,
	words: { text: "I lean toward the in-process LRU because it adds no service to run.", picked: false },
	retained,
	withdrawn,
};

test("a run quoting the withdrawn sentence fails, even when every other step succeeded", () => {
	assert.equal(scoreRun(good), true);
	assert.equal(scoreRun({ ...good, words: { text: "Decision on the build cache: use the Redis service for build caching, it is the cache we pick.", picked: false } }), false);
});

test("a page with no words line, a picked fallback, or words from neither turn fails", () => {
	assert.equal(scoreRun({ ...good, words: null }), false);
	assert.equal(scoreRun({ ...good, words: { ...(good.words as { text: string }), picked: true } }), false);
	assert.equal(scoreRun({ ...good, words: { text: "Some other sentence.", picked: false } }), false);
	assert.equal(scoreRun({ ...good, publishedCheckedBytes: false }), false);
});

test("any failed run fails the evaluation", () => {
	assert.equal(exitCode([true, true]), 0);
	assert.equal(exitCode([true, false]), 1);
	assert.equal(exitCode([]), 1);
});
