// The agent program's HTTP setup: Pi's proxy setting, one undici dispatcher with Pi's idle timeout, and fetch on the
// same undici. Written against undici's public API, pinned to the coding agent's undici version, because the coding
// agent exports no HTTP setup. Remove this file in the fold that brings a public upstream export of it.

import { EventEmitter } from "node:events";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as undici from "undici";

// Node's 250 ms default can end valid connection attempts on high-latency routes (the coding agent's own value).
const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;

/** Applies Pi's `httpProxy` setting and installs one undici dispatcher, with Pi's idle timeout, for every fetch. */
export function configureHttp(settings: SettingsManager): void {
	const proxy = settings.getGlobalSettings().httpProxy?.trim();
	if (proxy) {
		process.env.HTTP_PROXY ??= proxy;
		process.env.HTTPS_PROXY ??= proxy;
	}
	const timeoutMs = settings.getHttpIdleTimeoutMs();
	const client = (origin: string | URL, options: object) => quiet(new undici.Client(origin, options as undici.Client.Options));
	undici.setGlobalDispatcher(
		quiet(
			new undici.EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: timeoutMs,
				headersTimeout: timeoutMs,
				connect: { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS },
				clientFactory: client,
				factory: (origin, options) =>
					(options as undici.Pool.Options).connections === 1
						? client(origin, options)
						: quiet(new undici.Pool(origin, { ...(options as undici.Pool.Options), factory: client })),
			}),
		),
	);
	// Node 26's bundled fetch can read compressed responses through npm undici's dispatcher without decompressing
	// them, so fetch must come from the same undici as the dispatcher.
	undici.install();
}

// Undici can emit an internal "error" while ending a fetch body mid-stream; the body still rejects through its
// reader, and without a listener EventEmitter's unhandled-"error" rule would end the process.
function quiet<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	return dispatcher;
}
