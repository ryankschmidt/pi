// A process that sets up HTTP exactly as the agent program does (configureHttp over pi's settings) and fetches one
// URL, so the setup's effects on a whole process can be observed: the idle timeout, a body cut off mid-stream, the
// proxy setting. Prints one JSON line with what happened, then "alive" once the event loop has turned again.
//   node test/fixtures/http-probe.ts <url> <idleTimeoutMs> [<httpProxy>]
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { configureHttp } from "../../src/http.ts";

const [url, timeout, proxy] = process.argv.slice(2) as [string, string, string | undefined];
const abandon = process.env.PROBE_ABANDON === "1";
configureHttp(SettingsManager.inMemory({ httpIdleTimeoutMs: Number(timeout), ...(proxy ? { httpProxy: proxy } : {}) }));
const started = Date.now();
let result: object;
try {
	const controller = new AbortController();
	const response = await fetch(url, { signal: controller.signal });
	if (abandon) {
		// The caller gives up after the first chunk, as a provider stream does when a turn is aborted.
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		controller.abort();
		await reader.read();
	}
	const body = await response.text();
	result = { ok: true, status: response.status, body, ms: Date.now() - started };
} catch (error) {
	const cause = (error as { cause?: { code?: string; name?: string } }).cause;
	result = { ok: false, error: String(error), cause: cause?.code ?? cause?.name ?? null, ms: Date.now() - started };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
// A late undici "error" event without a listener would end the process here, before "alive".
await new Promise((resolve) => setTimeout(resolve, 300));
process.stdout.write("alive\n");
