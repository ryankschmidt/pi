// The Claude Code version Pi Durable's Claude requests announce: the pinned Claude Code's, never Pi's built-in constant.
// Pi's Anthropic provider, on a Claude subscription login, sends `user-agent: claude-cli/<version>` with a version fixed
// in its source (packages/ai/src/api/anthropic-messages.ts, `claudeCodeVersion`; "2.1.280" at upstream v1.5.0).
// Anthropic refuses a model newer than that version with 400 `claude_code_version_too_old`: on Nov 17, 2026 every
// Claude Fable 5.2 turn on ThroughLine's Pi Provider was refused ("Claude Code 2.1.280 does not support this model;
// version 2.1.290 or newer is required"), while the pinned Claude Code was 2.1.322.
// The version comes from the same pin the standard prompt is captured from (claude-standard-prompt.ts, the FCCL
// config's real_targets.claude, which `ryan model list` reports as pinned_claude), so it moves with every pin move and
// needs no fork edit. The stock file is not edited: the program's model runtime is wrapped, and only a request header
// that already says `claude-cli/` is changed, so API-key, Bedrock and every other request goes out as Pi sends it.
import type { FetchFunction, Models } from "@earendil-works/pi-ai";

/** The product prefix of the `user-agent` Pi's Anthropic provider sends as Claude Code. */
export const CLAUDE_CLI_PREFIX = "claude-cli/";

/** A version the pin may name: digits and dots, with an optional suffix (`2.1.322`, `2.1.322-beta.1`). */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The result of choosing the announced version: the models to hand Durable, and what the program logs about it. */
export interface AnnouncedVersion {
	models: Models;
	log: string;
}

/**
 * `models` with every request's `user-agent: claude-cli/<x>` replaced by `claude-cli/<version>`. A `version` that is
 * not a version (the pinned binary's folder name is not one) leaves `models` unchanged: Pi's own constant is sent, and
 * the log line says so.
 */
export function withPinnedClaudeCodeVersion(models: Models, version: string): AnnouncedVersion {
	if (!VERSION.test(version)) {
		return { models, log: `claude code version: the pin names "${version}", not a version; Pi's built-in version is announced` };
	}
	const withFetch = <T extends { fetch?: FetchFunction }>(options: T | undefined): T =>
		({ ...options, fetch: claudeCliFetch(version, options?.fetch) }) as T;
	const wrapped: Models = {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		getAllModels: (provider) => models.getAllModels(provider),
		refresh: (options) => models.refresh(options),
		checkAuth: (providerId, options) => models.checkAuth(providerId, options),
		getAvailable: (providerId, options) => models.getAvailable(providerId, options),
		getAvailableOfType: (type, providerId, options) => models.getAvailableOfType(type, providerId, options),
		getAllAvailable: (providerId, options) => models.getAllAvailable(providerId, options),
		getAuth: models.getAuth.bind(models),
		login: (providerId, type, interaction, options) => models.login(providerId, type, interaction, options),
		logout: (providerId, options) => models.logout(providerId, options),
		stream: (model, context, options) => models.stream(model, context, withFetch(options)),
		complete: (model, context, options) => models.complete(model, context, withFetch(options)),
		streamSimple: (model, context, options) => models.streamSimple(model, context, withFetch(options)),
		completeSimple: (model, context, options) => models.completeSimple(model, context, withFetch(options)),
		streamDeferred: (model, handle, options) => models.streamDeferred(model, handle, withFetch(options)),
		fetchDeferred: (model, handle, options) => models.fetchDeferred(model, handle, withFetch(options)),
		cancelDeferred: (model, handle, options) => models.cancelDeferred(model, handle, withFetch(options)),
		generateImages: (model, context, options) => models.generateImages(model, context, options),
		classify: (model, context, options) => models.classify(model, context, options),
	};
	return { models: wrapped, log: `claude code version: ${CLAUDE_CLI_PREFIX}${version} announced on Claude subscription requests` };
}

/**
 * A fetch that sends `user-agent: claude-cli/<version>` where the request says `claude-cli/<anything>`, and leaves every
 * other request untouched. `base` is the request's own fetch; absent, the global fetch at call time (the program
 * installs undici's fetch at start, after this module loads).
 */
export function claudeCliFetch(version: string, base?: FetchFunction): FetchFunction {
	return (input, init) => {
		const send = base ?? globalThis.fetch;
		const headers = new Headers(init?.headers);
		if (!headers.get("user-agent")?.startsWith(CLAUDE_CLI_PREFIX)) return send(input, init);
		headers.set("user-agent", `${CLAUDE_CLI_PREFIX}${version}`);
		return send(input, { ...init, headers });
	};
}
