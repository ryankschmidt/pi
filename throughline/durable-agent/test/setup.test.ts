// The agent program's model choice at start (initialModel) and its HTTP setup (configureHttp), against pi's real
// model runtime and settings and real local servers: these parts replaced coding-agent code and are owned here now.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialModel } from "../src/setup.ts";

const PROBE = fileURLToPath(new URL("./fixtures/http-probe.ts", import.meta.url));
const closers: (() => void)[] = [];
after(() => {
	for (const close of closers) close();
});

async function runtimeWithModels(): Promise<ModelRuntime> {
	const dir = mkdtempSync(join(tmpdir(), "durable-models-"));
	const models = join(dir, "models.json");
	writeFileSync(
		models,
		JSON.stringify({
			providers: {
				local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local", models: [{ id: "echo" }, { id: "other" }] },
			},
		}),
	);
	return await ModelRuntime.create({ modelsPath: models, authPath: join(dir, "auth.json") });
}

test("the start model: --model wins, else pi's default with its thinking level; no default or an unknown one starts modelless, never another model", async () => {
	const models = await runtimeWithModels();
	const withDefault = SettingsManager.inMemory({ defaultProvider: "local", defaultModel: "echo", defaultThinkingLevel: "high" });
	assert.deepEqual(initialModel(withDefault, models, "local/other"), { model: { provider: "local", modelId: "other" }, thinkingLevel: "high" });
	assert.deepEqual(initialModel(withDefault, models, undefined), { model: { provider: "local", modelId: "echo" }, thinkingLevel: "high" });
	// Models with a login exist, but with no default the agent waits for ThroughLine's configure instead of picking one.
	assert.deepEqual(initialModel(SettingsManager.inMemory({}), models, undefined), {});
	// A saved default naming a model that is gone starts modelless, not on a made-up custom model.
	assert.deepEqual(initialModel(SettingsManager.inMemory({ defaultProvider: "local", defaultModel: "gone" }), models, undefined), {});
	// An explicit id under a known provider passes through as stock pi's --model does; an unknown provider refuses.
	assert.deepEqual(initialModel(withDefault, models, "local/new-id").model, { provider: "local", modelId: "new-id" });
	assert.throws(() => initialModel(withDefault, models, "nowhere/echo"), /MODEL_NOT_RESOLVED/);
});

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
	const listening = createServer(handler);
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	closers.push(() => {
		listening.closeAllConnections();
		listening.close();
	});
	return (listening.address() as AddressInfo).port;
}

/** Runs the probe process; its env carries no proxy variables of the caller's. */
function probe(
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; result: Record<string, unknown>; alive: boolean; stderr: string }> {
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|no|all)_proxy$/i.test(key))),
		...extraEnv,
	};
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [PROBE, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		// A probe that never finishes (no idle timeout, say) is a failed probe, not a hung test run.
		const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("exit", (code) => {
			clearTimeout(deadline);
			const lines = out.trim().split("\n");
			resolve({ code, result: lines[0] ? (JSON.parse(lines[0]) as Record<string, unknown>) : {}, alive: lines.includes("alive"), stderr: err });
		});
	});
}

test("a stream that stalls is cut off near pi's idle timeout, and the process lives on", { timeout: 30_000 }, async () => {
	const port = await server((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: first\n\n"); // then nothing more, connection held open
	});
	const run = await probe([`http://127.0.0.1:${port}/stall`, "400"]);
	assert.equal(run.result.ok, false, JSON.stringify(run.result));
	assert.equal(run.result.cause, "UND_ERR_BODY_TIMEOUT");
	assert.ok((run.result.ms as number) >= 350 && (run.result.ms as number) < 5_000, `cut off after ${String(run.result.ms)} ms`);
	assert.ok(run.alive && run.code === 0, run.stderr);
});

test("a body closed mid-stream fails that fetch only; the process does not end", { timeout: 30_000 }, async () => {
	const port = await server((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
		res.write("partial");
		setTimeout(() => res.socket?.destroy(), 50);
	});
	const run = await probe([`http://127.0.0.1:${port}/cut`, "10000"]);
	assert.equal(run.result.ok, false, JSON.stringify(run.result));
	assert.ok(run.alive && run.code === 0, `exit ${String(run.code)}: ${run.stderr}`);
	// The caller abandoning a stream after its first chunk (an aborted turn) also leaves the process running.
	const streaming = await server((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: first\n\n");
		const timer = setInterval(() => res.write("data: more\n\n"), 20);
		res.on("close", () => clearInterval(timer));
	});
	const abandoned = await probe([`http://127.0.0.1:${streaming}/stream`, "10000"], { PROBE_ABANDON: "1" });
	assert.equal(abandoned.result.ok, false, JSON.stringify(abandoned.result));
	assert.ok(abandoned.alive && abandoned.code === 0, `exit ${String(abandoned.code)}: ${abandoned.stderr}`);
});

test("pi's httpProxy setting sends requests through the proxy as a tunnel", { timeout: 30_000 }, async () => {
	const target = await server((_req, res) => res.end("from target"));
	// The dispatcher tunnels every request (proxyTunnel, as the coding agent sets it), so the proxy sees a CONNECT.
	const tunnels: string[] = [];
	const proxyServer = createServer((_req, res) => res.writeHead(405).end());
	proxyServer.on("connect", (req: IncomingMessage, client: Socket) => {
		tunnels.push(req.url ?? "");
		const [host, port] = (req.url ?? "").split(":");
		const upstream = connect(Number(port), host, () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
	closers.push(() => {
		proxyServer.closeAllConnections();
		proxyServer.close();
	});
	const proxy = (proxyServer.address() as AddressInfo).port;
	const run = await probe([`http://127.0.0.1:${target}/x`, "10000", `http://127.0.0.1:${proxy}`]);
	assert.equal(run.result.body, "from target", JSON.stringify(run.result));
	assert.deepEqual(tunnels, [`127.0.0.1:${target}`]);
	const direct = await probe([`http://127.0.0.1:${target}/x`, "10000"]);
	assert.equal(direct.result.body, "from target");
	assert.equal(tunnels.length, 1, "without the setting the request goes direct");
});
