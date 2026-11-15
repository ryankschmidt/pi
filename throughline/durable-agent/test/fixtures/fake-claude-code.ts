// A stand-in for the pinned Claude Code in the agent program's prompt capture: it sends one /v1/messages request to
// ANTHROPIC_BASE_URL with system blocks shaped like Claude Code's (billing header, identity line, prompt), the prompt
// read from $HOME/fake-claude-system.txt, then exits. The capture passes only HOME and a few settings to the binary.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const text = readFileSync(join(process.env.HOME ?? "", "fake-claude-system.txt"), "utf8");
await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model: "claude-opus-5-5",
		system: [
			{ type: "text", text: "x-anthropic-billing-header: fake" },
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text },
		],
		messages: [{ role: "user", content: "Reply with OK." }],
	}),
}).catch(() => undefined);
