// The announced Claude Code version (src/claude-code-version.ts): only a `claude-cli/` user-agent is changed, the
// request's own fetch still sends it, and a pin that names no version changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, type FetchFunction } from "@earendil-works/pi-ai";
import { claudeCliFetch, withPinnedClaudeCodeVersion } from "../src/claude-code-version.ts";

/** A fetch that records the user-agent of each request it is given. */
function recorder() {
	const agents: (string | null)[] = [];
	const fetch: FetchFunction = async (_input, init) => {
		agents.push(new Headers(init?.headers).get("user-agent"));
		return new Response("{}");
	};
	return { agents, fetch };
}

test("a claude-cli user-agent is sent with the pinned version, in plain-object and Headers form", async () => {
	const { agents, fetch } = recorder();
	const send = claudeCliFetch("2.1.322", fetch);
	await send("https://api.anthropic.com/v1/messages", { headers: { "user-agent": "claude-cli/2.1.280", "x-app": "cli" } });
	await send("https://api.anthropic.com/v1/messages", { headers: new Headers({ "User-Agent": "claude-cli/2.1.280" }) });
	assert.deepEqual(agents, ["claude-cli/2.1.322", "claude-cli/2.1.322"]);
});

test("every other request goes out exactly as given", async () => {
	const { agents, fetch } = recorder();
	const send = claudeCliFetch("2.1.322", fetch);
	const init = { headers: { "User-Agent": "pi/1.5.0 (darwin; node/v26.0.0; arm64)" } };
	await send("https://api.anthropic.com/v1/messages", init);
	await send("https://example.com/");
	assert.deepEqual(agents, ["pi/1.5.0 (darwin; node/v26.0.0; arm64)", null]);
});

test("a pin that names no version leaves the models as they are and says so", () => {
	const models = createModels();
	const kept = withPinnedClaudeCodeVersion(models, "claude");
	assert.equal(kept.models, models);
	assert.match(kept.log, /not a version; Pi's built-in version is announced/);
	const wrapped = withPinnedClaudeCodeVersion(models, "2.1.322-beta.1");
	assert.notEqual(wrapped.models, models);
	assert.equal(wrapped.log, "claude code version: claude-cli/2.1.322-beta.1 announced on Claude subscription requests");
});
