// The /show-me evaluation's verdict for one run, as a pure function so its failures can be tested (Rereview8-2 #2).

/** The words line a show-me page records (base64 JSON in its show-me-words meta tag). */
export type PageWords = { text: string; picked: boolean };

/** What one evaluated run did, read from its stored entries. */
export type RunFacts = {
	snapshotBeforeBuild: boolean;
	buildTranscriptIsSnapshot: boolean;
	buildSucceeded: boolean;
	checkSucceeded: boolean;
	publishedCheckedBytes: boolean;
	rewound: boolean;
	words: PageWords | null;
	/** The user's retained turn; the words line must come from it. */
	retained: string;
	/** The turn a rewind withdrew; the words line must never come from it. */
	withdrawn: string;
};

/**
 * Whether a run passes: every step succeeded, and the page's words line is a sentence from the retained turn, not a
 * picked fallback, and never from the withdrawn turn (checked on every run, not only rewound ones).
 */
export function scoreRun(facts: RunFacts): boolean {
	const words = facts.words?.text.trim() ?? "";
	const wordsOk = words.length > 0 && facts.words?.picked === false && facts.retained.includes(words) && !facts.withdrawn.includes(words);
	return (
		facts.snapshotBeforeBuild &&
		facts.buildTranscriptIsSnapshot &&
		facts.buildSucceeded &&
		facts.checkSucceeded &&
		facts.publishedCheckedBytes &&
		wordsOk
	);
}

/** The evaluation's exit code: non-zero when any run failed. */
export function exitCode(passed: readonly boolean[]): number {
	return passed.length > 0 && passed.every(Boolean) ? 0 : 1;
}
