// The real agent program (src/main.ts) as ThroughLine runs it, against a local model endpoint that records each
// request: what reaches the model is what these tests check. The program runs from a copy laid out as the installer
// lays it out (throughline/durable-agent with capabilities/ beside src/, node_modules at the root), so the pinned image
// module and the pinned show-me skill are found where an install puts them. Pi's settings are shaped like Ryan's: they
// list no show-me skill.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getDocsPath } from "@earendil-works/pi-coding-agent";
import { SHIPPED_IMAGE_MODULE, SHIPPED_SHOW_ME } from "../install/runtime.ts";
import { type AgentProgram, startProgram } from "../src/client.ts";

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const APPEND_MARKER = "APPEND-MARKER-7f3c: operator bootstrap for this test";
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

/** A local OpenAI-compatible endpoint: answers request n with replies[n] (the last one repeats) and records bodies. */
async function modelEndpoint(replies: Reply[]) {
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
			bodies.push(JSON.parse(raw) as RequestBody);
			const reply = replies[Math.min(bodies.length - 1, replies.length - 1)] as Reply;
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

/** The program copied as an install lays it out, a pi agent folder pointing at the endpoint, and a working folder. */
function layout(port: number, options: { images: Images; sameNamedShowMe?: boolean }) {
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
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "echo" }] } } }),
	);
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
	const start = (): AgentProgram => {
		const started = startProgram(
			process.execPath,
			[join(programDir, "src/main.ts"), "--store", join(root, "store"), "--agent", "real-agent", "--cwd", cwd, "--model", "local/echo"],
			{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } },
		);
		programs.push(started);
		return started;
	};
	return { start, cwd, showMe, root };
}

async function turn(program: AgentProgram, content: string, requestId: string): Promise<string> {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	return ((await program.call("wait", { submissionId })) as { status: string }).status;
}

type Stored = { kind: string; id: number; model?: { role: string; content: unknown }[] };
/** The entries the bound conversation shows, through the program's own `entries` call: what ThroughLine reads. */
async function storedEntries(program: AgentProgram): Promise<Stored[]> {
	const all: Stored[] = [];
	let cursor: unknown;
	do {
		const page = (await program.call("entries", { limit: 100, ...(cursor === undefined ? {} : { cursor }) })) as { items: Stored[]; next?: unknown };
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

	const answer = (await storedEntries(second)).find((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("shown"));
	await second.call("fork", { entryId: answer?.id });
	assert.equal(await turn(second, "in the fork", "k3"), "done", second.stderr());
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
