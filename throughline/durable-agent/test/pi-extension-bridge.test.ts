import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ToolTask } from "@earendil-works/pi-durable";
import { startProgram } from "../src/client.ts";
import { BRIDGE_PREFIX, bridgePiExtensions, describeReport, discoverPiExtensions } from "../src/pi-extension-bridge.ts";

// Ryan's installed extensions are read, never written or installed.
const INSTALLED = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "extensions");
const BOUNDARY_GATE = join(INSTALLED, "boundary-gate.js");
const IMAGES = join(INSTALLED, "subscription-images.js");
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const COUNTING_GATE = join(fixtures, "bridge-extensions", "counting-gate.js");
const program = join(fixtures, "faux-bridge-program.ts");
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});
const tempRoot = async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-extension-bridge-test-"));
	roots.push(root);
	return root;
};

/** A HookApi with only what the bridge uses: the conversation, task memos and committed reads. */
function fakeApi(conversationId = "c1") {
	const memos = new Map<string, unknown>();
	return {
		conversationId,
		memo: async (name: string, ...rest: unknown[]) => {
			if (rest.length === 1) return memos.get(name);
			if (!memos.has(name)) memos.set(name, rest[0]);
			return memos.get(name);
		},
		entry: async () => undefined,
		entries: async () => ({ items: [] }),
	} as never;
}

const CONTEXT = { abortSignal: new AbortController().signal } as never;

describe("Ryan's installed Pi extensions", () => {
	test("every installed file is bridged with a report of what mapped and what did not", async () => {
		const paths = discoverPiExtensions(await tempRoot(), join(INSTALLED, ".."));
		const lines: string[] = [];
		const bridge = await bridgePiExtensions(paths, { cwd: tmpdir(), log: (line) => lines.push(line) });
		assert.equal(bridge.reports.length, paths.length);
		assert.equal(lines.length, paths.length, "one start line per extension, so nothing is dropped silently");
		for (const report of bridge.reports) assert.ok(report.name.startsWith(BRIDGE_PREFIX));

		const gate = bridge.reports.find((report) => report.path === BOUNDARY_GATE);
		assert.equal(gate?.status, "loaded");
		const gateEvents = gate?.mapped.filter((part) => part.kind === "event").map((part) => part.name).sort();
		assert.deepEqual(gateEvents, [
			"agent_end",
			"message_end",
			"session_before_compact",
			"session_start",
			"tool_call",
			"tool_result",
			"turn_end",
		]);
		assert.deepEqual(
			gate?.unmapped.map((part) => part.name),
			["session_compact"],
			"the after-compaction onboarding nudge has no Durable hook",
		);

		const images = bridge.reports.find((report) => report.path === IMAGES);
		assert.deepEqual(
			images?.mapped.map((part) => part.name),
			["generate_image", "edit_image", "inspect_image"],
		);
		assert.deepEqual([...bridge.readOnly], ["inspect_image"]);
	});
});

describe("verdicts", () => {
	test("a tool_call verdict is memoized per tool task, so a rerun after a crash does not check again", async () => {
		const bridge = await bridgePiExtensions([COUNTING_GATE], { cwd: tmpdir() });
		const hooks = bridge.extensions[0]?.hooks?.find((entry) => entry.task === ToolTask.definition.name)?.handlers as {
			beforeTool: (call: unknown, api: unknown, context: unknown) => Promise<unknown>;
		};
		const call = { id: "call-1", name: "bash", arguments: { command: "echo hi" } };
		const api = fakeApi();
		const first = await hooks.beforeTool(call, api, CONTEXT);
		const rerun = await hooks.beforeTool(call, api, CONTEXT);
		assert.deepEqual(first, { arguments: { command: "echo hi # checked" } }, "an in-place input edit becomes arguments");
		assert.deepEqual(rerun, first);
		assert.equal((globalThis as { countingGateChecks?: number }).countingGateChecks, 1, "the rerun reused the memo");

		const blocked = await hooks.beforeTool({ id: "call-2", name: "bash", arguments: { command: "rm -rf x" } }, fakeApi(), CONTEXT);
		assert.deepEqual(blocked, { block: "no rm" });
		assert.equal((globalThis as { countingGateChecks?: number }).countingGateChecks, 2, "a new tool task checks again");
	});

	test("unmapped registrations, events, context members and actions are reported, and commands are listed and run", async () => {
		const lines: string[] = [];
		const bridge = await bridgePiExtensions([COUNTING_GATE], { cwd: tmpdir(), log: (line) => lines.push(line) });
		const report = bridge.reports[0];
		assert.deepEqual(bridge.commands, [
			{ extension: `${BRIDGE_PREFIX}counting-gate`, name: "gate-status", description: "Report the gate's check count" },
		]);
		assert.ok(report?.unmapped.some((part) => part.kind === "registration" && part.name === "messageRenderers"));
		assert.ok(report?.unmapped.some((part) => part.kind === "event" && part.name === "session_compact"));
		const hooks = bridge.extensions[0]?.hooks?.[0]?.handlers as {
			beforeTool: (call: unknown, api: unknown, context: unknown) => Promise<unknown>;
		};
		await hooks.beforeTool({ id: "call-3", name: "read", arguments: { path: "a" } }, fakeApi(), CONTEXT);
		assert.ok(report?.unmapped.some((part) => part.kind === "ctx" && part.name === "ctx.model"));
		assert.equal(await bridge.runCommand("gate-status", "", tmpdir()), true);
		assert.equal(await bridge.runCommand("nope", "", tmpdir()), false);
		assert.ok(report?.unmapped.some((part) => part.name === "ctx.ui.notify"));
		assert.match(lines.join("\n"), /ctx\.model unmapped on Durable/);
		assert.match(describeReport(report!), /tool_call->ToolTask\.beforeTool/);
	});

	test("a file that does not load is reported failed and still installs its name", async () => {
		const missing = join(await tempRoot(), "gone.js");
		const bridge = await bridgePiExtensions([missing], { cwd: tmpdir() });
		assert.equal(bridge.reports[0]?.status, "failed");
		assert.equal(bridge.extensions[0]?.name, `${BRIDGE_PREFIX}gone`);
	});
});

describe("a Durable agent with boundary-gate.js and subscription-images.js bridged", () => {
	test("the image tool runs, the JEV gate decides the compaction and then holds write tools", async () => {
		const requests: { operation?: string; questions?: Record<string, unknown> }[] = [];
		// A stand-in for the tower JEV broker: the gate's two questions, answered "at a clean point".
		const broker = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				requests.push(JSON.parse(body));
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						state: "DELIVERED",
						result: { model: "stub", answers: { edit_half_done: { noul: 0.1 }, at_boundary: { noul: 0.9 } } },
					}),
				);
			});
		});
		await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
		const port = (broker.address() as AddressInfo).port;
		const root = await tempRoot();
		const store = join(root, "store");
		await writeFile(join(root, "dot.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
		const agent = startProgram(process.execPath, [program, store, root, BOUNDARY_GATE, IMAGES], {
			env: { ...process.env, BOUNDARY_GATE_JEV_URL: `http://127.0.0.1:${port}/v1/jev-capability` },
		});
		try {
			await agent.hello;
			const run = async (content: string, requestId: string) => {
				const { submissionId } = (await agent.call("submit", { content, requestId })) as { submissionId: number };
				const settled = (await agent.call("wait", { submissionId })) as { status: string };
				assert.equal(settled.status, "done", `${requestId} settles`);
			};
			await run("look at dot.png", "r1");
			await run("add a line to a.txt", "r2");
			await agent.call("compact", { wait: true });
			await run("continue", "r3");
			await agent.call("drain");
			await agent.exited;
		} finally {
			broker.close();
		}
		assert.equal(requests.length, 1, "the gate asked JEV once, at the compaction");
		assert.equal(requests[0]?.operation, "jev.evaluate");
		assert.deepEqual(Object.keys(requests[0]?.questions ?? {}).sort(), ["at_boundary", "edit_half_done"]);
		const transcript = await readFile(join(store, "transcript.jsonl"), "utf8");
		assert.match(transcript, /Read-only preview of [^"]*dot\.png/, "inspect_image ran through the bridge");
		assert.match(transcript, /CONTEXT BOUNDARY/, "the gate's handoff summary replaced the compaction summary");
		assert.match(transcript, /boundary-gate hold: post-boundary onboarding is reading, never writing/);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\n", "the held bash call did not run");
	});
});

describe("the agent program", () => {
	test("bridges the extensions in the agent folder at start and says what it mapped", async () => {
		const root = await tempRoot();
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await mkdir(join(root, "cwd"));
		await copyFile(COUNTING_GATE, join(agentDir, "extensions", "counting-gate.js"));
		const agent = startProgram(
			process.execPath,
			[main, "--store", join(root, "store"), "--agent", "a1", "--cwd", join(root, "cwd")],
			{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
		);
		await agent.hello;
		await agent.call("drain");
		await agent.exited;
		assert.match(agent.stderr(), /pi-extension:counting-gate: mapped tool_call->ToolTask\.beforeTool/);
		assert.match(agent.stderr(), /unmapped session_compact \(Durable has no after-compaction hook\)/);
	});
});
