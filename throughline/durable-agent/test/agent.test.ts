// The real agent program (src/main.ts) as ThroughLine runs it, against a local model endpoint that records each
// request: what reaches the model is what these tests check. The program runs from a copy laid out as the installer
// lays it out (throughline/durable-agent with capabilities/ beside src/, node_modules at the root), so the pinned image
// module and the pinned show-me skill are found where an install puts them. Pi's settings are shaped like Ryan's: they
// list no show-me skill.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** What the image module copy holds: the shipped module, nothing, or a copy that loads but is broken in one way. */
type Images = "shipped" | "none" | { shared: string; effects: string };

/** The program copied as an install lays it out, a pi agent folder pointing at the endpoint, and a working folder. */
function layout(port: number, options: { images: Images }) {
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
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [other], compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), `${APPEND_MARKER}\n`);

	const cwd = join(root, "work");
	mkdirSync(cwd);
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

test("/show-me and /skill:show-me expand through the pinned skill with pi's settings listing no show-me; unknown commands stay as typed", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const program = layout(model.port, { images: "none" }).start();
	await program.hello;
	const cases: [string, RegExp][] = [
		["/show-me the next step", /^<skill name="show-me" location="[^"]+SKILL\.md">\nReferences are relative to [^\n]+\n\n[\s\S]+\n<\/skill>\n\nthe next step$/],
		["/skill:show-me", /^<skill name="show-me" location="[^"]+SKILL\.md">[\s\S]+<\/skill>$/],
		["/skill:no-such-skill go", /^\/skill:no-such-skill go$/],
	];
	for (const [index, [typed, expected]] of cases.entries()) {
		assert.equal(await turn(program, typed, `s${index}`), "done", program.stderr());
		assert.match(userTexts(model.bodies.at(-1) as RequestBody).at(-1) ?? "", expected, typed);
	}
	await stop(program);
});

test("a skill command keeps the instructions it was submitted with after the skill file changes and the program restarts", { timeout: 90_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const setup = layout(model.port, { images: "none" });
	writeFileSync(setup.showMe, "---\nname: show-me\ndescription: Show.\ndisable-model-invocation: true\n---\nBODY-AS-SUBMITTED\n");
	const first = setup.start();
	await first.hello;
	assert.equal(await turn(first, "/show-me the plan", "k1"), "done", first.stderr());
	await stop(first);

	// The skill is edited (a new ship) and the agent restarts on the same store; the next turn resends history.
	writeFileSync(setup.showMe, "---\nname: show-me\ndescription: Show.\ndisable-model-invocation: true\n---\nBODY-AFTER-EDIT\n");
	const second = setup.start();
	await second.hello;
	assert.equal(await turn(second, "and now?", "k2"), "done", second.stderr());
	const history = userTexts(model.bodies.at(-1) as RequestBody);
	assert.equal(history.length, 2, JSON.stringify(history));
	assert.match(history[0] ?? "", /BODY-AS-SUBMITTED[\s\S]*the plan$/, "the first turn replays what it was submitted with");
	assert.doesNotMatch(history.join("\n"), /BODY-AFTER-EDIT/);
	// The stored turn itself holds the expansion, so the store, not the skill file, decides what is replayed.
	assert.match(readFileSync(join(setup.root, "store/transcript.jsonl"), "utf8"), /BODY-AS-SUBMITTED/);
	await stop(second);
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
		[
			"a tool without an object schema",
			{
				shared: 'export const imageToolDescriptions = { inspect_image: "Look" };\nexport const imageToolParameters = { inspect_image: "not a schema" };\n',
				effects: "export const runImageTool = async () => ({ content: [], details: null });\n",
			},
			/inspect_image has no object parameter schema/,
		],
		[
			"a tool named like a coding tool",
			{
				shared: 'export const imageToolDescriptions = { read: "Clash" };\nexport const imageToolParameters = { read: { type: "object", properties: {} } };\n',
				effects: "export const runImageTool = async () => ({ content: [], details: null });\n",
			},
			/read would replace Durable's coding tool of that name/,
		],
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
