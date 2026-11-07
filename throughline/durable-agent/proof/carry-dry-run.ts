// Dry run of the carry over real stock Pi session files: each file is carried into a throwaway store, the model
// context Durable would send is built, and the source file's sha256 is checked unchanged. Nothing in ThroughLine moves.
//   node proof/carry-dry-run.ts <out.json> <session file>...

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { carrySession } from "../src/carry.ts";

const [out, ...files] = process.argv.slice(2) as [string, ...string[]];
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const results = [];
for (const file of files) {
	const before = sha(file);
	const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
	const root = mkdtempSync(join(tmpdir(), "carry-dry-"));
	try {
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(root, "store.sqlite")),
			{ models: createModels(), registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: root }) },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: root } });
		const summary = await carrySession(harness, conversation, file, root, BACKGROUND_CONTEXT);
		const view = await conversation.context(BACKGROUND_CONTEXT);
		const carried = Object.values(summary.carried).reduce((a, b) => a + b, 0);
		const images = view.messages.reduce(
			(n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => (p as { type: string }).type === "image").length : 0),
			0,
		);
		results.push({
			file,
			sourceLines: lines,
			carriedEntries: carried,
			allCarried: carried === lines,
			carried: summary.carried,
			contextMessages: view.messages.length,
			contextImages: images,
			sourceUnchanged: sha(file) === before,
		});
		await harness.close(BACKGROUND_CONTEXT);
	} catch (error) {
		results.push({ file, error: error instanceof Error ? error.message : String(error) });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
const ok = results.filter((r) => "allCarried" in r && r.allCarried && r.sourceUnchanged).length;
console.log(JSON.stringify({ files: files.length, ok, failed: results.length - ok }));
