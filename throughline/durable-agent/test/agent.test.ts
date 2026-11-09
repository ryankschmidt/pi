// The real agent program (src/main.ts) as ThroughLine runs it, against a local model endpoint that records each
// request: what reaches the model is what these tests check. The program runs from a copy laid out as the installer
// lays it out (throughline/durable-agent with capabilities/ beside src/, node_modules at the root), so the image
// module is found where an install puts it.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentProgram, startProgram } from "../src/client.ts";
import { SHIPPED_IMAGE_MODULE } from "../install/runtime.ts";

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

/** The program copied as an install lays it out, a pi agent folder pointing at the endpoint, and a working folder. */
function layout(port: number, options: { images: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "durable-agent-real-"));
	roots.push(root);
	const programDir = join(root, "throughline/durable-agent");
	cpSync(join(AGENT_DIR, "src"), join(programDir, "src"), { recursive: true });
	cpSync(join(AGENT_DIR, "package.json"), join(programDir, "package.json"));
	if (options.images) {
		// Inside an installed copy the pinned module is beside the program; in a source checkout, the shipped one.
		const pinned = join(AGENT_DIR, "capabilities/subscription-images");
		const source = existsSync(pinned) ? pinned : SHIPPED_IMAGE_MODULE;
		for (const name of ["shared.mjs", "effects.mjs"]) cpSync(join(source, name), join(programDir, "capabilities/subscription-images", name));
	}
	let up = AGENT_DIR;
	while (!existsSync(join(up, "node_modules/@earendil-works/pi-durable"))) up = dirname(up);
	symlinkSync(join(up, "node_modules"), join(root, "node_modules"));

	const agentDir = join(root, "pi-agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "echo" }] } } }),
	);
	const skill = join(agentDir, "show-me/SKILL.md");
	const shipped = "/Users/Admin/.codex/skills/show-me/SKILL.md";
	if (existsSync(shipped)) cpSync(shipped, skill);
	else {
		mkdirSync(dirname(skill), { recursive: true });
		writeFileSync(skill, "---\nname: show-me\ndescription: Show the current work.\ndisable-model-invocation: true\n---\nShow $ARGUMENTS as one visual.\n");
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [skill], compaction: { enabled: false } }));
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
	return { start, cwd };
}

async function turn(program: AgentProgram, content: string, requestId: string): Promise<string> {
	const { submissionId } = (await program.call("submit", { content, requestId })) as { submissionId: number };
	return ((await program.call("wait", { submissionId })) as { status: string }).status;
}

const systemText = (body: RequestBody) =>
	body.messages
		.filter((message) => message.role === "system" || message.role === "developer")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
const lastUserText = (body: RequestBody) => {
	const content = body.messages.filter((message) => message.role === "user").at(-1)?.content;
	return typeof content === "string" ? content : JSON.stringify(content);
};

test("the prompt carries APPEND_SYSTEM.md once and the project context, without stock pi's identity, docs or PI_* line", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const program = layout(model.port, { images: false }).start();
	await program.hello;
	assert.equal(await turn(program, "hello", "p1"), "done", program.stderr());
	const system = systemText(model.bodies[0] as RequestBody);
	assert.equal(system.split(APPEND_MARKER).length - 1, 1, "APPEND_SYSTEM.md appears exactly once");
	assert.match(system, /Project rule: keep answers short\./);
	assert.doesNotMatch(system, /running inside pi|Pi documentation|PI_\* environment/);
	await program.call("drain");
	await program.exited;
});

test("/show-me and /skill:show-me reach the model as the skill block with the arguments; unknown commands stay as typed", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const program = layout(model.port, { images: false }).start();
	await program.hello;
	const cases: [string, RegExp][] = [
		["/show-me the next step", /^<skill name="show-me" location="[^"]+SKILL\.md">\nReferences are relative to [^\n]+\n\n[\s\S]+\n<\/skill>\n\nthe next step$/],
		["/skill:show-me", /^<skill name="show-me" location="[^"]+SKILL\.md">[\s\S]+<\/skill>$/],
		["/skill:no-such-skill go", /^\/skill:no-such-skill go$/],
	];
	for (const [index, [typed, expected]] of cases.entries()) {
		assert.equal(await turn(program, typed, `s${index}`), "done", program.stderr());
		assert.match(lastUserText(model.bodies.at(-1) as RequestBody), expected, typed);
	}
	await program.call("drain");
	await program.exited;
});

test("inspect_image runs from the installed copy of the image module, without an approval question", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ tool: "inspect_image", args: { image_path: "pixel.png" } }, { text: "seen" }]);
	const program = layout(model.port, { images: true }).start();
	const questions: string[] = [];
	program.onQuestion((question) => questions.push(JSON.stringify(question)));
	await program.hello;
	assert.equal(await turn(program, "look at pixel.png", "i1"), "done", program.stderr());
	assert.ok((model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "inspect_image"), "the model is offered inspect_image");
	assert.match(JSON.stringify(model.bodies[1]?.messages), /Read-only preview of [^"]*pixel\.png/);
	assert.deepEqual(questions, []);
	await program.call("drain");
	await program.exited;
});

test("with no image module copy the agent still starts and answers, without image tools, and says why on stderr", { timeout: 60_000 }, async () => {
	const model = await modelEndpoint([{ text: "ok" }]);
	const program = layout(model.port, { images: false }).start();
	await program.hello;
	assert.equal(await turn(program, "hello", "m1"), "done", program.stderr());
	assert.ok(!(model.bodies[0]?.tools ?? []).some((tool) => tool.function.name === "inspect_image"));
	assert.match(program.stderr(), /image tools unavailable: no installed copy at .*capabilities\/subscription-images\/shared\.mjs/);
	await program.call("drain");
	await program.exited;
});
