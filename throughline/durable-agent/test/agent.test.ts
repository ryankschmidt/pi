// The real agent program (src/main.ts) as ThroughLine runs it, against a local model endpoint that records each
// request: what reaches the model is what these tests check. The program runs from a copy laid out as the installer
// lays it out (throughline/durable-agent with capabilities/ beside src/, node_modules at the root), so the pinned image
// module and the pinned show-me skill are found where an install puts them. Pi's settings are shaped like Ryan's: they
// list no show-me skill. Each program runs with a temporary HOME holding an FCCL config that pins a fake Claude Code and
// a cached standard prompt for it, so Claude Code's standard prompt resolves at start without Ryan's live cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { getDocsPath } from "@earendil-works/pi-coding-agent";
import { SHIPPED_IMAGE_MODULE, SHIPPED_SHOW_ME } from "../install/runtime.ts";
import { type AgentProgram, startProgram } from "../src/client.ts";
import { EXIT } from "../src/program.ts";

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const APPEND_MARKER = "APPEND-MARKER-7f3c: operator bootstrap for this test";
const CLAUDE_VERSION = "9.9.9-fake";
// Standard prompts over the 1,000-character floor: the cached one, the one the fake Claude Code captures, and a capture
// that names the capture's temporary folder, as Claude Code's auto memory section did. The capture trims what it
// keeps, so the captured text carries no trailing space.
const RECORD_TEXT = `CACHED-STANDARD-PROMPT-4e1a\n${"You are an interactive agent that helps users with software engineering tasks. ".repeat(16)}`;
const CAPTURED_TEXT = `CAPTURED-STANDARD-PROMPT-9b2c\n${"Use the tools available to you to assist the user. ".repeat(24)}`.trimEnd();
const LEAKY_TEXT = `${CAPTURED_TEXT}\n# Memory\nKeep memory in /var/folders/x/T/pi-claude-standard-prompt-a1b2c3/projects/memory/.`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const promptRecord = (claudeBin: string, text: string) =>
	JSON.stringify({ claude_bin: claudeBin, claude_version: CLAUDE_VERSION, text, sha256: sha(text), first_line: text.split("\n")[0], captured_at: "2026-11-15T10:00:00.000Z" });
// A 1x1 PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const roots: string[] = [];
const servers: Server[] = [];
const programs: AgentProgram[] = [];
after(() => {
	// A failed assertion leaves its program running; stop it so the runner can exit.
	for (const program of programs) program.kill();
	for (const server of servers) server.close();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Reply = { text: string } | { tool: string; args: object };
type RequestBody = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };

/**
 * A local OpenAI-compatible endpoint: answers request n with replies[n] (the last one repeats), or with what `replies`
 * returns for the request's body, and records bodies.
 */
async function modelEndpoint(replies: Reply[] | ((body: RequestBody) => Reply)) {
	const bodies: RequestBody[] = [];
	const server = createServer((req, res) => {
		// Other local software probes newly opened ports (GET /); only the model requests are the agent's.
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as RequestBody;
			bodies.push(body);
			const reply = typeof replies === "function" ? replies(body) : (replies[Math.min(bodies.length - 1, replies.length - 1)] as Reply);
			const delta =
				"text" in reply
					? { role: "assistant", content: reply.text }
					: {
							role: "assistant",
							tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
						};
			const chunk = (body: object) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 0, model: "echo", ...body })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ choices: [{ index: 0, delta, finish_reason: null }] }));
			res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { bodies, port: (server.address() as AddressInfo).port };
}

type AnthropicBody = { model: string; system?: { text: string }[]; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };

/** A local Anthropic Messages endpoint: answers every request with `reply`, or with what `reply` returns for the body, and records bodies and headers. */
async function anthropicEndpoint(reply: string | ((body: AnthropicBody) => Reply)) {
	const bodies: AnthropicBody[] = [];
	const headers: NodeJS.Dict<string | string[]>[] = [];
	const server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		headers.push(req.headers);
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as AnthropicBody;
			bodies.push(body);
			const answer: Reply = typeof reply === "string" ? { text: reply } : reply(body);
			const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(event("message_start", { message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }));
			if ("text" in answer) {
				res.write(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
				res.write(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer.text } }));
			} else {
				res.write(event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${bodies.length}`, name: answer.tool, input: {} } }));
				res.write(event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(answer.args) } }));
			}
			res.write(event("content_block_stop", { index: 0 }));
			res.write(event("message_delta", { delta: { stop_reason: "text" in answer ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } }));
			res.end(event("message_stop", {}));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { bodies, headers, port: (server.address() as AddressInfo).port };
}

type CodexBody = { model: string; input: { type?: string; role?: string; content?: unknown; output?: unknown }[]; tools?: { name: string }[] };

/**
 * A local Codex Responses endpoint, as Pi's openai-codex-responses API reaches ChatGPT's Codex backend. It refuses the
 * WebSocket upgrade, so the client falls back to its SSE transport; it reads the zstd body, answers with what `reply`
 * returns for it, and records bodies.
 */
async function codexEndpoint(reply: (body: CodexBody) => Reply) {
	const bodies: CodexBody[] = [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/codex/responses")) {
			res.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);
			const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8")) as CodexBody;
			bodies.push(body);
			const answer = reply(body);
			const n = bodies.length;
			const item =
				"text" in answer
					? { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer.text }] }
					: { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: answer.tool, arguments: JSON.stringify(answer.args), status: "completed" };
			const data = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(data({ type: "response.output_item.added", output_index: 0, item: "content" in item ? { ...item, status: "in_progress", content: [] } : { ...item, status: "in_progress", arguments: "" } }));
			res.write(data({ type: "response.output_item.done", output_index: 0, item }));
			res.end(data({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } }));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { bodies, port: (server.address() as AddressInfo).port };
}

/** An access token shaped like ChatGPT's, from which the Codex API reads the account id. It is not a credential. */
const CODEX_TEST_TOKEN = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } })).toString("base64")}.bbb`;

const anthropicSystem = (body: AnthropicBody | undefined) => (body?.system ?? []).map((block) => block.text).join("\n");

/** A loadable image module copy declaring `tools`, each with an object schema unless `schemas` overrides it. */
function imageCopy(tools: string[], schemas: Record<string, object> = {}): { shared: string; effects: string } {
	const descriptions = Object.fromEntries(tools.map((name) => [name, `The ${name} tool`]));
	const parameters = Object.fromEntries(tools.map((name) => [name, schemas[name] ?? { type: "object", properties: {} }]));
	return {
		shared: `export const imageToolDescriptions = ${JSON.stringify(descriptions)};\nexport const imageToolParameters = ${JSON.stringify(parameters)};\n`,
		effects: "export const runImageTool = async () => ({ content: [], details: null });\n",
	};
}

/** What the image module copy holds: the shipped module, nothing, or a copy that loads but is broken in one way. */
type Images = "shipped" | "none" | { shared: string; effects: string };

/**
 * A temporary HOME as the program reads it: the FCCL config pinning a fake Claude Code, the text that fake sends, and
 * a valid cached standard prompt for it. `pinClaude` points the config at another binary.
 */
function claudeHome(root: string) {
	const home = join(root, "home");
	const claudeBin = join(home, ".local/share/claude/versions", CLAUDE_VERSION);
	mkdirSync(dirname(claudeBin), { recursive: true });
	writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${join(AGENT_DIR, "test/fixtures/fake-claude-code.ts")}' "$@"\n`);
	chmodSync(claudeBin, 0o755);
	writeFileSync(join(home, "fake-claude-system.txt"), CAPTURED_TEXT);
	const config = join(home, ".local/state/ryan/fccl/static-shim-config.json");
	mkdirSync(dirname(config), { recursive: true });
	const pinClaude = (bin: string) => writeFileSync(config, JSON.stringify({ real_targets: { claude: bin } }));
	pinClaude(claudeBin);
	const stateDir = join(home, ".local/state/pi-claude-standard-prompt");
	const recordPath = join(stateDir, `standard-prompt-${CLAUDE_VERSION}.json`);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(recordPath, promptRecord(claudeBin, RECORD_TEXT));
	return { home, claudeBin, stateDir, recordPath, pinClaude, captures: (text: string) => writeFileSync(join(home, "fake-claude-system.txt"), text) };
}

/** The program copied as an install lays it out, a pi agent folder pointing at the endpoint, and a working folder. */
function layout(port: number, options: { images: Images; sameNamedShowMe?: boolean; claudeModel?: boolean; claudeApiKey?: string; agentId?: string }) {
	const root = mkdtempSync(join(tmpdir(), "durable-agent-real-"));
	roots.push(root);
	const programDir = join(root, "throughline/durable-agent");
	cpSync(join(AGENT_DIR, "src"), join(programDir, "src"), { recursive: true });
	cpSync(join(AGENT_DIR, "package.json"), join(programDir, "package.json"));
	const imageDir = join(programDir, "capabilities/subscription-images");
	if (options.images === "shipped") {
		// Inside an installed copy the pinned module is beside the program; in a source checkout, the shipped one.
		const pinned = join(AGENT_DIR, "capabilities/subscription-images");
		const source = existsSync(pinned) ? pinned : SHIPPED_IMAGE_MODULE;
		for (const name of ["shared.mjs", "effects.mjs"]) cpSync(join(source, name), join(imageDir, name));
	} else if (options.images !== "none") {
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, "shared.mjs"), options.images.shared);
		writeFileSync(join(imageDir, "effects.mjs"), options.images.effects);
	}
	// The show-me skill pinned where the installer pins it, from the shipped copy when there is one.
	const showMe = join(programDir, "capabilities/skills/show-me/SKILL.md");
	const pinnedShowMe = join(AGENT_DIR, "capabilities/skills/show-me/SKILL.md");
	const showMeSource = existsSync(pinnedShowMe) ? pinnedShowMe : SHIPPED_SHOW_ME;
	mkdirSync(dirname(showMe), { recursive: true });
	if (existsSync(showMeSource)) cpSync(showMeSource, showMe);
	else writeFileSync(showMe, "---\nname: show-me\ndescription: Show the current work.\ndisable-model-invocation: true\n---\nShow $ARGUMENTS as one visual.\n");
	let up = AGENT_DIR;
	while (!existsSync(join(up, "node_modules/@earendil-works/pi-durable"))) up = dirname(up);
	symlinkSync(join(up, "node_modules"), join(root, "node_modules"));

	const agentDir = join(root, "pi-agent");
	mkdirSync(agentDir);
	// The endpoint speaks one API: OpenAI's by default, Anthropic Messages (as Pi's own Anthropic provider does) for Claude.
	const provider = options.claudeModel
		? { "claude-local": { baseUrl: `http://127.0.0.1:${port}`, api: "anthropic-messages", apiKey: options.claudeApiKey ?? "local", models: [{ id: "claude-test" }] } }
		: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "echo" }] } };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: provider }));
	const claude = claudeHome(root);
	// Shaped like Ryan's settings: a skills list without show-me.
	const other = join(agentDir, "skills-elsewhere/other/SKILL.md");
	mkdirSync(dirname(other), { recursive: true });
	writeFileSync(other, "---\nname: other\ndescription: Another skill.\n---\nOther.\n");
	const skills = [other];
	const cwd = join(root, "work");
	mkdirSync(cwd);
	if (options.sameNamedShowMe) {
		// A model-callable show-me in each place pi looks: its default folder, the project, and a configured path.
		const rival = (file: string, where: string) => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `---\nname: show-me\ndescription: A rival show-me.\n---\nRIVAL-${where}\n`);
		};
		rival(join(agentDir, "skills/show-me/SKILL.md"), "DEFAULT");
		rival(join(cwd, ".pi/skills/show-me/SKILL.md"), "PROJECT");
		const configured = join(agentDir, "configured/show-me/SKILL.md");
		rival(configured, "CONFIGURED");
		skills.unshift(configured);
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), `${APPEND_MARKER}\n`);

	writeFileSync(join(cwd, "AGENTS.md"), "Project rule: keep answers short.\n");
	writeFileSync(join(cwd, "pixel.png"), Buffer.from(PIXEL, "base64"));
	const start = (env: NodeJS.ProcessEnv = {}): AgentProgram => {
		const started = startProgram(
			process.execPath,
			[join(programDir, "src/main.ts"), "--store", join(root, "store"), "--agent", options.agentId ?? "real-agent", "--cwd", cwd, "--model", options.claudeModel ? "claude-local/claude-test" : "local/echo"],
			{ env: { ...process.env, HOME: claude.home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...env } },
		);
		programs.push(started);
		return started;
	};
	return { start, cwd, showMe, root, claude };
}


async function turn(program: AgentProgram, content: string, requestId: string, conversationId?: number): Promise<string> {
	const { submissionId } = (await program.call("submit", { conversationId: conversationId ?? (await program.root()), content, requestId })) as { submissionId: number };
	return ((await program.call("wait", { submissionId })) as { status: string }).status;
}

type Stored = { kind: string; id: number; model?: { role: string; content: unknown; sections?: Record<string, string | null> }[] };
/** The entries a conversation shows (the root unless named), through the program's own `entries` call: what ThroughLine reads. */
async function storedEntries(program: AgentProgram, conversationId?: number): Promise<Stored[]> {
	const all: Stored[] = [];
	const named = conversationId ?? (await program.root());
	let cursor: unknown;
	do {
		const page = (await program.call("entries", { conversationId: named, limit: 100, ...(cursor === undefined ? {} : { cursor }) })) as { items: Stored[]; next?: unknown };
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined && cursor !== null);
	return all;
}
const storedUserTexts = async (program: AgentProgram) =>
	(await storedEntries(program))
		.filter((entry) => entry.kind === "pi.user")
		.map((entry) => entry.model?.[0]?.content)
		.map((content) => (typeof content === "string" ? content : JSON.stringify(content)));

async function stop(program: AgentProgram): Promise<void> {
	await program.call("drain");
	await program.exited;
}

const systemText = (body: RequestBody) =>
	body.messages
		.filter((message) => message.role === "system" || message.role === "developer")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
const userTexts = (body: RequestBody) =>
	body.messages
		.filter((message) => message.role === "user")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));

test("the prompt carries APPEND_SYSTEM.md once, the project context and Pi and Durable docs that exist, without stock pi's identity or PI_* line", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const program = layout(model.port, { images: "none" }).start();
	await program.hello;
	assert.equal(await turn(program, "hello", "p1"), "done", program.stderr());
	const system = systemText(model.bodies[0] as RequestBody);
	assert.equal(system.split(APPEND_MARKER).length - 1, 1, "APPEND_SYSTEM.md appears exactly once");
	assert.match(system, /Project rule: keep answers short\./);
	assert.doesNotMatch(system, /running inside pi|PI_\* environment/);
	assert.ok(!system.includes(RECORD_TEXT), "a model that is not on the Anthropic Messages API gets no Claude standard prompt");
	// The docs guidance names folders an agent can actually read: pi's docs and Pi Durable's README.
	assert.ok(system.includes(getDocsPath()), "pi's docs folder is named");
	const durableReadme = /Pi Durable: (\S+README\.md)/.exec(system)?.[1];
	assert.ok(durableReadme !== undefined && existsSync(durableReadme), `Pi Durable's README is named and exists (${durableReadme})`);
	assert.ok(existsSync(getDocsPath()));
	await stop(program);
});

// Build round 12: no snapshot tool. The transcript section names the store folder, which an old show-me body passes as
// "the transcript path your system prompt names"; show-me then asks this agent for the live branch.
test("the prompt names the store folder as the transcript for show-me, and no snapshot tool is offered", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "written" }]);
	const program = layout(model.port, { images: "none" }).start();
	const hello = await program.hello;
	assert.equal(await turn(program, "Show the plan.", "t1"), "done", program.stderr());
	const system = systemText(model.bodies[0] as RequestBody);
	assert.ok(system.includes(`<transcript>\nThis conversation's transcript, for skills such as show-me: ${hello.store} (show-me asks this running agent for the live branch at that moment).`), system.slice(system.indexOf("<transcript>"), system.indexOf("<transcript>") + 300));
	assert.ok(!(model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "conversation_snapshot"), "no snapshot tool");
	await stop(program);
});

// Build round 13, item 2: when the read socket cannot be created the agent still answers, and the thread's prompt says
// plainly that show-me cannot read it now and why, so the thread can tell the user.
test("when the read socket cannot be created the prompt says show-me cannot read this thread now, and why", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "written" }]);
	const setup = layout(model.port, { images: "none" });
	const program = setup.start({ TMPDIR: join(setup.root, "no-such-folder") });
	const hello = await program.hello;
	assert.equal(await turn(program, "Show the plan.", "t1"), "done", program.stderr());
	const system = systemText(model.bodies[0] as RequestBody);
	assert.match(system, new RegExp(`<transcript>\\nThis conversation's transcript is in ${hello.store}, but show-me cannot read it now: the read socket could not be created: .*ENOENT`));
	await stop(program);
});

test("show-me is listed as a command with the read-first rule, with pi's settings listing no show-me; a command reaches the model as typed", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const setup = layout(model.port, { images: "none" });
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, "/show-me the next step", "s1"), "done", program.stderr());
	const system = systemText(model.bodies[0] as RequestBody);
	const commands = /<available_commands>([\s\S]*?)<\/available_commands>/.exec(system)?.[1] ?? "";
	assert.match(commands, /<name>show-me<\/name>/);
	assert.ok(commands.includes(`<location>${realpathSync(setup.showMe)}</location>`), "the pinned show-me file is the listed location");
	assert.match(system, /read that file with read before anything else[\s\S]*where the file says \$ARGUMENTS, use that text/);
	assert.match(system, /<available_skills>[\s\S]*<name>other<\/name>/, "model-callable skills are listed as before");
	assert.equal(userTexts(model.bodies[0] as RequestBody).at(-1), "/show-me the next step", "the command reaches the model as typed");
	await stop(program);
});

test("a command's skill body is the read result stored in its run: replayed unchanged after a skill edit, a restart and a fork", { timeout: 90_000 }, async () => {
	// The endpoint reads its replies when each request arrives, so the first one can name the file once it exists.
	const replies: Reply[] = [{ text: "unset" }, { text: "shown" }];
	const model = await modelEndpoint(replies);
	const setup = layout(model.port, { images: "none" });
	writeFileSync(setup.showMe, "---\nname: show-me\ndescription: Show.\ndisable-model-invocation: true\n---\nBODY-AS-READ\n");
	// The scripted model reads the listed file, as the prompt rule asks.
	replies[0] = { tool: "read", args: { path: realpathSync(setup.showMe) } };
	const first = setup.start();
	await first.hello;
	assert.equal(await turn(first, "/show-me the plan", "k1"), "done", first.stderr());
	assert.match(JSON.stringify(model.bodies[1]?.messages), /BODY-AS-READ/, "the next request carries the body as a tool result");
	// One stored record of the turn, as typed; nothing else stands in for it.
	assert.deepEqual(await storedUserTexts(first), ["/show-me the plan"]);
	assert.equal((await storedEntries(first)).filter((entry) => !entry.kind.startsWith("pi.")).length, 0, "no record outside Durable's own kinds");
	await stop(first);

	writeFileSync(setup.showMe, "---\nname: show-me\ndescription: Show.\ndisable-model-invocation: true\n---\nBODY-AFTER-EDIT\n");
	const second = setup.start();
	await second.hello;
	assert.equal(await turn(second, "and now?", "k2"), "done", second.stderr());
	const resent = JSON.stringify(model.bodies.at(-1)?.messages);
	assert.match(resent, /BODY-AS-READ/, "the restart resends the stored read result");
	assert.doesNotMatch(resent, /BODY-AFTER-EDIT/);
	assert.equal(userTexts(model.bodies.at(-1) as RequestBody)[0], "/show-me the plan");

	// A rewind cuts "and now?", so the fork ends at the stored answer before it.
	const cut = (await storedEntries(second)).find((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("and now?"));
	const fork = (await second.call("fork", { conversationId: await second.root(), before: String(cut?.id) })) as { conversationId: number };
	assert.equal(await turn(second, "in the fork", "k3", fork.conversationId), "done", second.stderr());
	const forked = JSON.stringify(model.bodies.at(-1)?.messages);
	assert.match(forked, /BODY-AS-READ/, "the fork resends the stored read result");
	assert.doesNotMatch(forked, /BODY-AFTER-EDIT/);
	await stop(second);
});

test("the pinned show-me wins over same-named skills in pi's default, project and configured skills", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const setup = layout(model.port, { images: "none", sameNamedShowMe: true });
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, "/skill:show-me y", "c1"), "done", program.stderr());
	const system = systemText(model.bodies.at(-1) as RequestBody);
	const listed = [...system.matchAll(/<name>show-me<\/name>/g)].length;
	assert.equal(listed, 1, "show-me is listed once");
	assert.ok(system.includes(`<location>${realpathSync(setup.showMe)}</location>`), "the listed show-me is the pinned file");
	// The rivals are model-callable, so they would be listed under available_skills; the pinned copy replaces them.
	assert.doesNotMatch(system, /A rival show-me|RIVAL-/);
	await stop(program);
});

test("inspect_image runs from the installed copy of the image module, without an approval question", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ tool: "inspect_image", args: { image_path: "pixel.png" } }, { text: "seen" }]);
	const program = layout(model.port, { images: "shipped" }).start();
	const questions: string[] = [];
	program.onQuestion((question) => questions.push(JSON.stringify(question)));
	await program.hello;
	assert.equal(await turn(program, "look at pixel.png", "i1"), "done", program.stderr());
	assert.ok((model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "inspect_image"), "the model is offered inspect_image");
	assert.match(JSON.stringify(model.bodies[1]?.messages), /Read-only preview of [^"]*pixel\.png/);
	assert.deepEqual(questions, []);
	await stop(program);
});

test("an absent, unloadable or incompatible image module never stops the agent: it answers without image tools and says why", { timeout: 120_000 }, async () => {
	const cases: [string, Images, RegExp][] = [
		["absent", "none", /image tools unavailable: no installed copy at .*capabilities\/subscription-images\/shared\.mjs/],
		["throws on import", { shared: "throw new Error('broken copy');\n", effects: "export {};\n" }, /did not load \(broken copy\)/],
		["exports the wrong names", { shared: "export const unrelated = 1;\n", effects: "export const other = 2;\n" }, /does not provide usable image tools \(imageToolDescriptions is not an object\)/],
		["lacks two of the three tools", imageCopy(["inspect_image"]), /the copy lacks generate_image, edit_image/],
		["a tool without an object schema", imageCopy(["generate_image", "edit_image", "inspect_image"], { inspect_image: { type: "object" } }), /inspect_image has no object parameter schema/],
		["a property schema that is not a schema", imageCopy(["generate_image", "edit_image", "inspect_image"], { generate_image: { type: "object", properties: { prompt: 5 } } }), /A schema must be an object or a boolean, got 5/],
		["an unknown extra tool, such as one named like a coding tool", imageCopy(["generate_image", "edit_image", "inspect_image", "read"]), /does not know: read/],
	];
	for (const [name, images, reason] of cases) {
		const model = await modelEndpoint([{ text: "ok" }]);
		const program = layout(model.port, { images }).start();
		await program.hello;
		assert.equal(await turn(program, "hello", `m-${name}`), "done", `${name}: ${program.stderr()}`);
		assert.ok(!(model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "inspect_image"), name);
		assert.match(program.stderr(), reason, name);
		await stop(program);
	}
});

test("an install-shaped copy without the old schema data file starts with image tools and answers", { timeout: 60_000 }, async () => {
	// Rereview4-1 #2 and 4-2 #3: a missing data file the image loader read at import stopped the whole agent.
	const model = await modelEndpoint([{ text: "ok" }]);
	const setup = layout(model.port, { images: "shipped" });
	rmSync(join(setup.root, "throughline/durable-agent/src/json-schema-2020-12.json"), { force: true });
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, "hello", "j1"), "done", program.stderr());
	assert.ok((model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "generate_image"), "the image tools are offered");
	await stop(program);
});

// Claude Code's standard prompt. Pi Durable skips a section that throws and sends the request anyway, so the program
// resolves the prompt before it answers hello; these cases run the real program against an Anthropic Messages endpoint.
test("a Claude model's request carries Claude Code's standard prompt first, and the start line names its version and sha", { timeout: 60_000 }, async () => {
	const model = await anthropicEndpoint("ok");
	const program = layout(model.port, { images: "none", claudeModel: true }).start();
	await program.hello;
	assert.equal(await turn(program, "hello", "c1"), "done", program.stderr());
	const system = anthropicSystem(model.bodies[0]);
	assert.ok(system.startsWith(RECORD_TEXT), `the standard prompt comes first: ${system.slice(0, 120)}`);
	assert.ok(program.stderr().includes(`claude standard prompt: claude ${CLAUDE_VERSION} sha ${sha(RECORD_TEXT).slice(0, 12)}`), program.stderr());
	await stop(program);
});

// Nov 17, 2026: every Claude Fable 5.2 turn on ThroughLine's Pi Provider was refused with 400 claude_code_version_too_old
// ("Claude Code 2.1.280 does not support this model"), because Pi's Anthropic provider announces a Claude Code version
// fixed in its source. This guards the mount in main.ts: without it the request says claude-cli/2.1.280 and this fails.
test("a Claude subscription request announces the pinned Claude Code's version, and an API-key request keeps Pi's own user-agent", { timeout: 90_000 }, async () => {
	const subscription = await anthropicEndpoint("ok");
	const program = layout(subscription.port, { images: "none", claudeModel: true, claudeApiKey: "sk-ant-oat01-local-test" }).start();
	await program.hello;
	assert.equal(await turn(program, "hello", "v1"), "done", program.stderr());
	assert.equal(subscription.headers[0]?.["user-agent"], `claude-cli/${CLAUDE_VERSION}`, program.stderr());
	assert.ok(program.stderr().includes(`claude code version: claude-cli/${CLAUDE_VERSION} announced`), program.stderr());
	await stop(program);

	const apiKey = await anthropicEndpoint("ok");
	const keyed = layout(apiKey.port, { images: "none", claudeModel: true }).start();
	await keyed.hello;
	assert.equal(await turn(keyed, "hello", "v2"), "done", keyed.stderr());
	assert.match(String(apiKey.headers[0]?.["user-agent"]), /^pi\//, "an API-key request is not dressed as Claude Code");
	await stop(keyed);
});

test("when the standard prompt cannot be had the program refuses to start, says why, and sends no Claude request", { timeout: 60_000 }, async () => {
	const model = await anthropicEndpoint("ok");
	const setup = layout(model.port, { images: "none", claudeModel: true });
	writeFileSync(setup.claude.recordPath, '{"claude_bin": "/Users/');
	setup.claude.pinClaude(join(setup.root, "no-such-claude", CLAUDE_VERSION));
	const program = setup.start();
	const started = await program.hello.then(
		() => true,
		() => false,
	);
	// A program that starts anyway is asked for a turn, which shows whether a Claude request leaves without the prompt.
	if (started) await turn(program, "hello", "r1").catch(() => undefined);
	assert.equal(model.bodies.length, 0, `no Claude request is sent: ${program.stderr()}`);
	assert.equal(await program.exited, EXIT.promptUnavailable);
	assert.match(program.stderr(), /^CLAUDE_STANDARD_PROMPT_UNAVAILABLE: .*ENOENT.*non-negotiable/m);
});

test("an unusable cached prompt is recaptured once from the pinned Claude Code and replaced whole", { timeout: 180_000 }, async () => {
	type Setup = ReturnType<typeof layout>;
	const cases: [string, (setup: Setup) => void][] = [
		["missing", (setup) => rmSync(setup.claude.recordPath)],
		["torn", (setup) => writeFileSync(setup.claude.recordPath, '{"claude_bin": "/Users/')],
		["altered", (setup) => writeFileSync(setup.claude.recordPath, JSON.stringify({ ...JSON.parse(promptRecord(setup.claude.claudeBin, RECORD_TEXT)), sha256: "0".repeat(64) }))],
		["for another binary", (setup) => writeFileSync(setup.claude.recordPath, promptRecord(join(setup.root, "other", CLAUDE_VERSION), RECORD_TEXT))],
		["naming the capture folder", (setup) => writeFileSync(setup.claude.recordPath, promptRecord(setup.claude.claudeBin, LEAKY_TEXT))],
	];
	for (const [name, damage] of cases) {
		const model = await anthropicEndpoint("ok");
		const setup = layout(model.port, { images: "none", claudeModel: true });
		damage(setup);
		const program = setup.start();
		await program.hello;
		assert.equal(await turn(program, "hello", `h-${name}`), "done", `${name}: ${program.stderr()}`);
		assert.ok(anthropicSystem(model.bodies[0]).startsWith(CAPTURED_TEXT), `${name}: the request carries the fresh capture`);
		assert.deepEqual(readdirSync(setup.claude.stateDir), [basename(setup.claude.recordPath)], `${name}: one record, no leftover file`);
		const record = JSON.parse(readFileSync(setup.claude.recordPath, "utf8")) as { claude_bin: string; text: string; sha256: string };
		assert.deepEqual([record.claude_bin, record.text, record.sha256], [setup.claude.claudeBin, CAPTURED_TEXT, sha(CAPTURED_TEXT)], name);
		await stop(program);
	}

	// A fresh capture that names its own temporary folder is refused, never cached or sent.
	const model = await anthropicEndpoint("ok");
	const setup = layout(model.port, { images: "none", claudeModel: true });
	rmSync(setup.claude.recordPath);
	setup.claude.captures(LEAKY_TEXT);
	const program = setup.start();
	await assert.rejects(program.hello);
	assert.equal(await program.exited, EXIT.promptUnavailable);
	assert.match(program.stderr(), /^CLAUDE_STANDARD_PROMPT_UNAVAILABLE: .*temporary capture folder/m);
	assert.equal(model.bodies.length, 0);
	assert.ok(!existsSync(setup.claude.recordPath), "nothing is cached");
});

test("after a kill the restarted program still sends the standard prompt first, and the store holds it once", { timeout: 90_000 }, async () => {
	const model = await anthropicEndpoint("ok");
	const setup = layout(model.port, { images: "none", claudeModel: true });
	const first = setup.start();
	await first.hello;
	assert.equal(await turn(first, "one", "k1"), "done", first.stderr());
	first.kill();
	await first.exited;
	const second = setup.start();
	await second.hello;
	assert.equal(await turn(second, "two", "k2"), "done", second.stderr());
	assert.ok(anthropicSystem(model.bodies.at(-1)).startsWith(RECORD_TEXT), "the second program's request carries the prompt first");
	const stored = (await storedEntries(second))
		.filter((entry) => entry.kind === "pi.system")
		.map((entry) => entry.model?.[0]?.sections?.claude_standard)
		.filter((text) => text !== undefined);
	assert.deepEqual(stored, [RECORD_TEXT], "one claude_standard value across both programs");
	await stop(second);
});

// layout's pi settings carry compaction.enabled false, as Ryan's do for stock Pi threads. A Durable agent still compacts,
// at the threshold pi's own keys set in the project's settings, and reaches what the summary replaced through search_history.
test("past pi's compaction threshold the agent compacts, keeps answering, and search_history reaches an entry from before the summary", { timeout: 90_000 }, async () => {
	const MARKER = "PRECOMPACT-NOTE-1d7e";
	const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
	const model = await modelEndpoint((body) => {
		const last = body.messages.at(-1);
		if (last?.role === "tool") return { text: "found the note" };
		// The summary request offers no tools; the agent's own turn does.
		if (body.tools?.length && text(last?.content).includes("SEARCH-NOW")) return { tool: "search_history", args: { query: MARKER } };
		return { text: "Summary: the user left a note earlier." };
	});
	const setup = layout(model.port, { images: "none" });
	writeFileSync(
		join(setup.root, "pi-agent/models.json"),
		JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "echo", contextWindow: 128_000 }] } } }),
	);
	// Blocking threshold 10,000 tokens (128,000 - 118,000), set only through pi's keys in the project's settings.
	mkdirSync(join(setup.cwd, ".pi"));
	writeFileSync(join(setup.cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 2_000, modelOverrides: { "local/echo": { reserveTokens: 118_000 } } } }));
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, `Remember this note: ${MARKER}.`, "c1"), "done", program.stderr());
	// About 12,000 estimated tokens: over the threshold, so this turn compacts before its request.
	assert.equal(await turn(program, `SEARCH-NOW for the note. ${"filler words that grow the context ".repeat(1_400)}`, "c2"), "done", program.stderr());

	const stored = await storedEntries(program);
	assert.ok(stored.some((entry) => entry.kind === "pi.compaction"), `the store holds a compaction entry: ${stored.map((entry) => entry.kind).join(", ")}`);
	assert.ok(stored.some((entry) => entry.kind === "pi.user" && text(entry.model?.[0]?.content).includes(MARKER)), "the entry from before the compaction is still stored");
	const asked = model.bodies.find((body) => body.tools?.length && text(body.messages.at(-1)?.content).includes("SEARCH-NOW"));
	assert.ok(asked !== undefined, "the turn after the compaction reached the model");
	assert.ok(!asked.messages.some((message) => message.role !== "system" && text(message.content).includes(MARKER)), "after the compaction the model no longer sees the note");
	assert.ok(asked.tools?.some((tool) => tool.function.name === "search_history"), "search_history is offered");
	const result = model.bodies.map((body) => body.messages.at(-1)).find((message) => message?.role === "tool");
	assert.ok(result !== undefined, "search_history answered without an approval question");
	const page = JSON.parse(text(result.content)) as { results: { context: string; text: string }[] };
	const hit = page.results.find((entry) => entry.text.includes(MARKER));
	assert.equal(hit?.context, "compacted", text(result.content));

	// The compaction lives in the store, not the process: a restarted program still sends the summary, not the note,
	// and search_history still reaches the note as compacted.
	program.kill();
	await program.exited;
	const sent = model.bodies.length;
	const second = setup.start();
	await second.hello;
	assert.equal(await turn(second, "SEARCH-NOW once more.", "c3"), "done", second.stderr());
	const later = model.bodies.slice(sent);
	const askedAgain = later.find((body) => body.tools?.length && text(body.messages.at(-1)?.content).includes("SEARCH-NOW once more"));
	assert.ok(askedAgain !== undefined, "the restarted program's turn reached the model");
	// The search call and its result after the compaction quote the marker; the user's original note must not come back.
	assert.ok(!askedAgain.messages.some((message) => message.role === "user" && text(message.content).includes(`Remember this note: ${MARKER}`)), "after the restart the model still sees the summary, not the note");
	const again = later.map((body) => body.messages.at(-1)).find((message) => message?.role === "tool");
	assert.ok(again !== undefined, "search_history answered after the restart");
	const hitAgain = (JSON.parse(text(again.content)) as { results: { context: string; text: string }[] }).results.find((entry) => entry.text.includes(MARKER));
	assert.equal(hitAgain?.context, "compacted", text(again.content));
	assert.equal((await storedEntries(second)).filter((entry) => entry.kind === "pi.compaction").length >= 1, true, "the compaction entry survives the restart");
	await stop(second);
});

// The case above runs on an OpenAI-completions endpoint. ThroughLine's main agent is Claude, on Anthropic Messages, where
// the standard prompt is a section rendered first: the compaction summary is written over the same API, and the turn
// after it still carries the standard prompt first and the summary in place of the earlier note, and search_history
// reaches the note over Anthropic's tool_use and tool_result blocks.
test("on a Claude model past the threshold the agent compacts over Anthropic Messages, keeps answering, keeps the standard prompt first, and search_history reaches the note", { timeout: 90_000 }, async () => {
	const MARKER = "PRECOMPACT-CLAUDE-5b9a";
	const isToolResult = (content: unknown) => Array.isArray(content) && content.some((block: { type?: string }) => block.type === "tool_result");
	const model = await anthropicEndpoint((body) => {
		const last = body.messages.at(-1);
		if (isToolResult(last?.content)) return { text: "found the note" };
		// The summary request offers no tools; the agent's own turn does.
		if (body.tools?.length && JSON.stringify(last?.content).includes("AFTER-COMPACT")) return { tool: "search_history", args: { query: MARKER } };
		return { text: "Summary: the user left a note earlier." };
	});
	const setup = layout(model.port, { images: "none", claudeModel: true });
	writeFileSync(
		join(setup.root, "pi-agent/models.json"),
		JSON.stringify({ providers: { "claude-local": { baseUrl: `http://127.0.0.1:${model.port}`, api: "anthropic-messages", apiKey: "local", models: [{ id: "claude-test", contextWindow: 128_000 }] } } }),
	);
	mkdirSync(join(setup.cwd, ".pi"));
	writeFileSync(join(setup.cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 2_000, modelOverrides: { "claude-local/claude-test": { reserveTokens: 118_000 } } } }));
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, `Remember this note: ${MARKER}.`, "k1"), "done", program.stderr());
	const before = model.bodies.length;
	assert.equal(await turn(program, `AFTER-COMPACT ${"filler words that grow the context ".repeat(1_400)}`, "k2"), "done", program.stderr());

	const stored = await storedEntries(program);
	assert.ok(stored.some((entry) => entry.kind === "pi.compaction"), `the store holds a compaction entry: ${stored.map((entry) => entry.kind).join(", ")}`);
	assert.ok(stored.some((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model?.[0]?.content).includes(MARKER)), "the entry from before the compaction is still stored");
	const later = model.bodies.slice(before);
	assert.ok(later.length >= 3, `a summary request, the turn's own request and the request after search_history all went over Anthropic Messages (${later.length})`);
	const asked = later.find((body) => body.tools?.length && JSON.stringify(body.messages.at(-1)?.content).includes("AFTER-COMPACT"));
	assert.ok(asked !== undefined, "the turn after the compaction reached the model");
	assert.ok(!JSON.stringify(asked.messages).includes(`Remember this note: ${MARKER}`), "after the compaction the model sees the summary, not the note");
	assert.ok(anthropicSystem(asked).startsWith(RECORD_TEXT), "the standard prompt still comes first after the compaction");
	assert.ok(asked.tools?.some((tool) => tool.name === "search_history"), "search_history is offered to the Claude model");
	const answered = later.find((body) => isToolResult(body.messages.at(-1)?.content));
	assert.ok(answered !== undefined, "search_history answered without an approval question");
	const resultText = JSON.stringify(answered.messages.at(-1)?.content);
	assert.ok(resultText.includes(MARKER) && resultText.includes("compacted"), `search_history quotes the note as compacted: ${resultText.slice(0, 400)}`);
	// With the threshold this low, a background compaction may follow the turn; that summary request has its own prompt.
	assert.ok(anthropicSystem(answered).startsWith(RECORD_TEXT), "the standard prompt still comes first on the request carrying the tool result");
	await stop(program);
});

// ThroughLine's Codex models reach ChatGPT's Codex backend through Pi's openai-codex-responses API, whose transport and
// request shape (instructions plus input items, function_call and function_call_output) differ from both cases above.
// The same compaction runs there: the summary is written over that API, the turn goes on, and search_history reaches
// the note from before the summary.
test("on a Codex model past the threshold the agent compacts over the Codex Responses API, keeps answering, and search_history reaches the note", { timeout: 90_000 }, async () => {
	const MARKER = "PRECOMPACT-CODEX-3e8f";
	const lastItem = (body: CodexBody) => body.input.at(-1);
	const model = await codexEndpoint((body) => {
		const last = lastItem(body);
		if (last?.type === "function_call_output") return { text: "found the note" };
		// The summary request offers no tools; the agent's own turn does.
		if (body.tools?.length && JSON.stringify(last?.content).includes("CODEX-AFTER")) return { tool: "search_history", args: { query: MARKER } };
		return { text: "Summary: the user left a note earlier." };
	});
	const setup = layout(model.port, { images: "none" });
	writeFileSync(
		join(setup.root, "pi-agent/models.json"),
		JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${model.port}`, api: "openai-codex-responses", apiKey: CODEX_TEST_TOKEN, models: [{ id: "echo", contextWindow: 128_000 }] } } }),
	);
	mkdirSync(join(setup.cwd, ".pi"));
	writeFileSync(join(setup.cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 2_000, modelOverrides: { "local/echo": { reserveTokens: 118_000 } } } }));
	const program = setup.start();
	await program.hello;
	assert.equal(await turn(program, `Remember this note: ${MARKER}.`, "x1"), "done", program.stderr());
	const before = model.bodies.length;
	assert.ok(before >= 1, "the first turn reached the Codex endpoint");
	assert.equal(await turn(program, `CODEX-AFTER ${"filler words that grow the context ".repeat(1_400)}`, "x2"), "done", program.stderr());

	const stored = await storedEntries(program);
	assert.ok(stored.some((entry) => entry.kind === "pi.compaction"), `the store holds a compaction entry: ${stored.map((entry) => entry.kind).join(", ")}`);
	assert.ok(stored.some((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model?.[0]?.content).includes(MARKER)), "the entry from before the compaction is still stored");
	const later = model.bodies.slice(before);
	assert.ok(later.some((body) => !body.tools?.length), "the compaction summary was written over the Codex Responses API");
	const asked = later.find((body) => body.tools?.length && JSON.stringify(lastItem(body)?.content).includes("CODEX-AFTER"));
	assert.ok(asked !== undefined, "the turn after the compaction reached the model");
	assert.ok(!JSON.stringify(asked.input).includes(`Remember this note: ${MARKER}`), "after the compaction the model sees the summary, not the note");
	assert.ok(asked.tools?.some((tool) => tool.name === "search_history"), "search_history is offered to the Codex model");
	const result = later.map(lastItem).find((item) => item?.type === "function_call_output");
	assert.ok(result !== undefined, "search_history answered without an approval question");
	const resultText = JSON.stringify(result.output);
	assert.ok(resultText.includes(MARKER) && resultText.includes("compacted"), `search_history quotes the note as compacted: ${resultText.slice(0, 400)}`);
	await stop(program);
});

// Tools-approvals done test, at the real entry: a desktop quit SIGTERMs src/main.ts while an approval waits. The program
// closes (exit 0), the next program asks the same question again without a new model request, and accept runs it once.
test("a SIGTERM while an approval waits: the restarted program asks the same question, replays no model request, and accept runs the tool once", { timeout: 90_000 }, async () => {
	const model = await modelEndpoint([{ tool: "bash", args: { command: "echo once >> witness.txt" } }, { text: "done" }]);
	const setup = layout(model.port, { images: "none" });
	const first = setup.start();
	const asked = new Promise<{ key: string; tool: string }>((resolve) => first.onQuestion(resolve));
	await first.hello;
	const { submissionId } = (await first.call("submit", { conversationId: await first.root(), content: "run it", requestId: "s1" })) as { submissionId: number };
	const question = await asked;
	assert.equal(question.tool, "bash");
	first.child.kill("SIGTERM");
	assert.equal(await first.exited, EXIT.ok, first.stderr());
	assert.ok(!existsSync(join(setup.cwd, "witness.txt")), "nothing ran before the answer");
	const second = setup.start();
	const again = new Promise<{ key: string; tool: string }>((resolve) => second.onQuestion(resolve));
	await second.hello;
	assert.equal((await again).key, question.key, "the same question, under the same key");
	assert.equal(model.bodies.length, 1, "the restart replays no model request");
	assert.deepEqual(await second.call("answer", { key: question.key, answer: "accept" }), { matched: true });
	assert.equal(((await second.call("wait", { submissionId })) as { status: string }).status, "done", second.stderr());
	assert.equal(readFileSync(join(setup.cwd, "witness.txt"), "utf8"), "once\n");
	assert.equal(model.bodies.length, 2, "one request after the tool result");
	await stop(second);
});

test("Durable bash receives the bound agent ID, clears stale Pi session files and keeps other environment values across restart and stores", { timeout: 90_000 }, async () => {
	const model = await modelEndpoint((body) => body.messages.at(-1)?.role === "tool"
		? { text: "done" }
		: { tool: "bash", args: { command: "printf '%s|%s|%s' \"$PI_SESSION_ID\" \"${PI_SESSION_FILE-unset}\" \"$WITNESS_ENV\" > identity.txt" } });
	const env = { PI_SESSION_ID: "stale-other-agent", PI_SESSION_FILE: "/wrong/session.jsonl", WITNESS_ENV: "kept" };
	const first = layout(model.port, { images: "none", agentId: "pi-first-agent" });
	const second = layout(model.port, { images: "none", agentId: "pi-second-agent" });
	const run = async (setup: typeof first, id: string, request: string) => {
		const program = setup.start(env);
		const asked = new Promise<{ key: string; tool: string }>((resolve) => program.onQuestion(resolve));
		await program.hello;
		const { submissionId } = (await program.call("submit", { conversationId: await program.root(), content: "run bash", requestId: request })) as { submissionId: number };
		const question = await asked;
		assert.equal(question.tool, "bash");
		await program.call("answer", { key: question.key, answer: "accept" });
		assert.equal(((await program.call("wait", { submissionId })) as { status: string }).status, "done", program.stderr());
		assert.equal(readFileSync(join(setup.cwd, "identity.txt"), "utf8"), `${id}|unset|kept`);
		await stop(program);
	};
	await run(first, "pi-first-agent", "first");
	await run(first, "pi-first-agent", "restart");
	await run(second, "pi-second-agent", "second");
});
