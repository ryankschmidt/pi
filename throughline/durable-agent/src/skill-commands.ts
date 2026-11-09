// Explicit skill commands in a Durable agent: a user message starting `/skill:<name>`, or `/<name>` for a skill marked
// `disable-model-invocation: true`, reaches the model as stock pi's skill block followed by the arguments. ThroughLine's
// composer menu for Pi threads offers these commands, so what it offers is what expands. `/show-me` works because
// show-me is such a skill, not because the program carries show-me code.
//
// Two records of one turn, each with one job. The user's message is stored as typed, so ThroughLine's snapshot, a
// fork's carried text and show-me read what Ryan wrote. Just before it, when the input is submitted, a data-only entry
// stores the exact skill block the turn was given; data-only entries never enter model context. Before each request
// the hook puts that stored block in place of the typed command, so a retry, a restart, a resumed request or a fork
// sends the same instructions however the skill file changes later. Nothing is read from skill files after submission.

import { readFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type Cursor,
	defineExtension,
	type EntryDraft,
	type EntryRecord,
	GenerationTask,
	type HookApi,
	hook,
	type UserInput,
} from "@earendil-works/pi-durable";

/** Kind of the data-only entry holding a skill command's exact expansion, written just before the typed input. */
export const SKILL_COMMAND_KIND = "throughline.skill-command";

/** What a skill-command entry stores: the command as typed and the exact text the model is sent instead of it. */
export type SkillCommandData = { typed: string; expanded: string; skill: string; location: string };

/** The entry to store before a submitted input, or undefined when its text is not a known skill command. */
export function skillCommandEntry(content: UserInput, skills: readonly Skill[]): EntryDraft | undefined {
	const typed = commandText(content);
	if (typed === undefined) return undefined;
	const resolved = resolveSkillCommand(typed, skills);
	if (resolved === undefined) return undefined;
	const data: SkillCommandData = { typed, expanded: resolved.expanded, skill: resolved.skill.name, location: resolved.skill.filePath };
	return { kind: SKILL_COMMAND_KIND, data };
}

/** The extension whose hook sends each stored expansion in place of its typed command. */
export function createSkillCommandsExtension() {
	return defineExtension({
		name: "skill-commands",
		hooks: [hook(GenerationTask, { beforeRequest: (request, api, context) => withStoredExpansions(request.messages, api, context) })],
	});
}

// Only user messages that look like a command are looked up, so a conversation without skill commands reads nothing.
async function withStoredExpansions(messages: readonly Message[], api: HookApi, context: Context) {
	const wanted = new Map<string, number>();
	messages.forEach((message, index) => {
		const typed = message.role === "user" ? commandText(message.content) : undefined;
		if (typed !== undefined && COMMAND.test(typed)) wanted.set(messageKey(message, typed), index);
	});
	if (wanted.size === 0) return undefined;
	const expansions = await findExpansions(wanted, api, context);
	if (expansions.size === 0) return undefined;
	return { messages: messages.map((message, index) => (expansions.has(index) ? replaceText(message, expansions.get(index) as string) : message)) };
}

/**
 * Newest first, each wanted user entry (same text and timestamp as the request's message) is paired with the nearest
 * skill-command entry before it that stores the same typed text: that entry was written just before the input.
 */
async function findExpansions(wanted: Map<string, number>, api: HookApi, context: Context): Promise<Map<number, string>> {
	const found = new Map<number, string>();
	const pending: { typed: string; index: number }[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await api.entries({ order: "descending" }, 200, cursor, context);
		for (const entry of page.items) {
			const user = userMessageOf(entry);
			if (user !== undefined) {
				const typed = commandText(user.content);
				const index = typed === undefined ? undefined : wanted.get(messageKey(user, typed));
				if (typed !== undefined && index !== undefined) pending.push({ typed, index });
				continue;
			}
			const data = skillCommandData(entry);
			if (data === undefined) continue;
			// The pending entry closest after this record: the newest-first walk saw it last.
			const at = pending.findLastIndex((item) => item.typed === data.typed);
			if (at < 0) continue;
			found.set((pending[at] as { index: number }).index, data.expanded);
			pending.splice(at, 1);
		}
		if (found.size === wanted.size) break;
		cursor = page.next;
	} while (cursor !== undefined);
	return found;
}

const userMessageOf = (entry: EntryRecord): Message | undefined =>
	entry.kind === "pi.user" && entry.model?.[0]?.role === "user" ? entry.model[0] : undefined;

function skillCommandData(entry: EntryRecord): SkillCommandData | undefined {
	if (entry.kind !== SKILL_COMMAND_KIND || typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return undefined;
	const data = entry.data as Partial<SkillCommandData>;
	return typeof data.typed === "string" && typeof data.expanded === "string" ? (data as SkillCommandData) : undefined;
}

const messageKey = (message: Message, typed: string) => `${"timestamp" in message ? String(message.timestamp) : ""}\0${typed}`;

function commandText(content: UserInput | Message["content"]): string | undefined {
	if (typeof content === "string") return content;
	const first = Array.isArray(content) ? content[0] : undefined;
	return first?.type === "text" ? first.text : undefined;
}

function replaceText(message: Message, text: string): Message {
	if (message.role !== "user") return message;
	if (typeof message.content === "string") return { ...message, content: text };
	const [first, ...rest] = message.content;
	return first?.type === "text" ? { ...message, content: [{ ...first, text }, ...rest] } : message;
}

const COMMAND = /^\/(skill:)?([^\s/]+)(?:\s+([\s\S]*))?$/;

/** Stock pi's `/skill:` expansion of `text`; undefined for an unknown name, a model-callable `/<name>` or an unreadable file. */
export function resolveSkillCommand(text: string, skills: readonly Skill[]): { expanded: string; skill: Skill } | undefined {
	const match = COMMAND.exec(text);
	if (match === null) return undefined;
	const [, explicit, name, rest] = match;
	const skill = skills.find((candidate) => candidate.name === name);
	// `/<name>` alone is a command only for skills the model may not call itself; others stay plain text.
	if (skill === undefined || (explicit === undefined && !skill.disableModelInvocation)) return undefined;
	let body: string;
	try {
		body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	} catch {
		return undefined;
	}
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	const args = rest?.trim() ?? "";
	return { expanded: args.length > 0 ? `${block}\n\n${args}` : block, skill };
}
