// Explicit skill commands in a Durable agent: a user message starting `/skill:<name>`, or `/<name>` for a skill marked
// `disable-model-invocation: true`, is submitted as stock pi's skill block followed by the arguments. ThroughLine's
// composer menu for Pi threads offers these commands, so what it offers is what expands. `/show-me` works because
// show-me is such a skill, not because the program carries show-me code.
//
// The expansion happens once, when the input is submitted, and the stored user message is the expanded text, as stock
// pi stores it. A retry, a restart, a resumed request or a fork therefore sends the instructions the turn was given,
// even after the skill file changes or goes away.

import { readFileSync } from "node:fs";
import { type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { UserInput } from "@earendil-works/pi-durable";

/** A submitted input with a leading skill command expanded; anything else is returned as given. */
export function expandSkillInput(content: UserInput, skills: readonly Skill[]): UserInput {
	if (typeof content === "string") return expandSkillCommand(content, skills);
	const [first, ...rest] = content;
	if (first?.type !== "text") return content;
	const text = expandSkillCommand(first.text, skills);
	return text === first.text ? content : [{ ...first, text }, ...rest];
}

/** Stock pi's `/skill:` expansion; an unknown name or an unreadable file leaves the text as typed. */
export function expandSkillCommand(text: string, skills: readonly Skill[]): string {
	const match = /^\/(skill:)?([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (match === null) return text;
	const [, explicit, name, rest] = match;
	const skill = skills.find((candidate) => candidate.name === name);
	// `/<name>` alone is a command only for skills the model may not call itself; others stay plain text.
	if (skill === undefined || (explicit === undefined && !skill.disableModelInvocation)) return text;
	let body: string;
	try {
		body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	} catch {
		return text;
	}
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	const args = rest?.trim() ?? "";
	return args.length > 0 ? `${block}\n\n${args}` : block;
}
