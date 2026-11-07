import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { carrySession } from "../src/carry.ts";

const fixture = fileURLToPath(new URL("./fixtures/stock-session.jsonl", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function open(storeDir: string) {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(storeDir, "store.sqlite")),
		{ models: createModels(), registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: storeDir }) },
		BACKGROUND_CONTEXT,
	);
	return { harness, conversation: await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: storeDir } }) };
}

test("a stock Pi session is carried whole: messages, tool calls and results, images, edits and records", async () => {
	const root = mkdtempSync(join(tmpdir(), "carry-test-"));
	roots.push(root);
	const session = join(root, "session.jsonl");
	copyFileSync(fixture, session);
	const first = await open(root);
	const summary = await carrySession(first.harness, first.conversation, session, root, BACKGROUND_CONTEXT);
	assert.deepEqual(summary.carried, {
		"throughline.carried-record": 3,
		"pi.user": 1,
		"pi.assistant": 2,
		"pi.tool-result": 1,
		"throughline.carried-context-edit": 1,
		"throughline.carried-custom-message": 1,
	});
	const view = await first.conversation.context(BACKGROUND_CONTEXT);
	const roles = view.messages.map((message) => message.role);
	// No stock system prompt reaches the model. The carried context edit omits the original tool result; Durable puts its
	// own missing-result stand-in after the call, because every call needs a result.
	assert.deepEqual(roles, ["user", "assistant", "toolResult", "user", "assistant"]);
	assert.doesNotMatch(JSON.stringify(view.messages[2]), /a\.txt/);
	assert.match(JSON.stringify(view.messages[3]), /a custom note/);
	const image = (view.messages[0]!.content as { type: string; data?: string }[]).find((part) => part.type === "image");
	assert.equal(image?.data, "iVBORw0KGgo=");
	assert.equal(JSON.parse(readFileSync(join(root, "carried-from.json"), "utf8")).path, session);
	await first.harness.close(BACKGROUND_CONTEXT);

	appendFileSync(
		session,
		`${JSON.stringify({ type: "message", id: "e9", parentId: "e8", message: { role: "user", content: "later", timestamp: 5 } })}\n`,
	);
	const second = await open(root);
	const again = await carrySession(second.harness, second.conversation, session, root, BACKGROUND_CONTEXT);
	assert.deepEqual(again.carried, { "pi.user": 1 });
	assert.equal(again.alreadyCarried, 9);
	await second.harness.close(BACKGROUND_CONTEXT);
});
