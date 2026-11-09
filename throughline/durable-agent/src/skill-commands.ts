// Explicit skill commands in a Durable agent: a user message starting `/skill:<name>`, or `/<name>` for a skill marked
// `disable-model-invocation: true`, reaches the model as stock pi's skill block followed by the arguments. ThroughLine's
// composer menu for Pi threads offers these commands, so what it offers is what expands. `/show-me` works because
// show-me is such a skill, not because the program carries show-me code.

import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { AgentResources } from "./setup.ts";

/** The skill-commands extension over the skills the prompt already lists for the conversation's folder. */
export function createSkillCommandsExtension(resources: AgentResources) {
	return defineExtension({
		name: "skill-commands",
		hooks: [
			hook(GenerationTask, {
				// The stored user message stays as typed; each request carries the expansion, read from the skill file then.
				beforeRequest: (request, api) => {
					const skills = resources.folder(resources.cwdOfConversation(api.conversationId)).skills;
					const messages = request.messages.map((message) => expandMessage(message, skills));
					return messages.some((message, index) => message !== request.messages[index]) ? { messages } : undefined;
				},
			}),
		],
	});
}

function expandMessage(message: Message, skills: readonly Skill[]): Message {
	if (message.role !== "user") return message;
	if (typeof message.content === "string") {
		const text = expandSkillCommand(message.content, skills);
		return text === message.content ? message : { ...message, content: text };
	}
	const [first, ...rest] = message.content;
	if (first?.type !== "text") return message;
	const text = expandSkillCommand(first.text, skills);
	return text === first.text ? message : { ...message, content: [{ ...first, text }, ...rest] };
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
