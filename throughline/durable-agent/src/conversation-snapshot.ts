// conversation_snapshot: the agent tool that writes the calling conversation, as the user sees it now (the live branch
// only, in order), to a new file beside the store and returns its path. The store is the only record of the
// conversation; nothing keeps a copy between calls, so no reader can see a stale or withdrawn branch. Skills that read
// the conversation (show-me) take the file this tool returns.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";

export const SNAPSHOT_TOOL = "conversation_snapshot";

/** The extension carrying the tool; snapshots go in `storeDir/snapshots/`, read `pageSize` entries at a time. */
export function createConversationSnapshotExtension(storeDir: string, pageSize = 500) {
	const folder = join(storeDir, "snapshots");
	return defineExtension({
		name: "conversation-snapshot",
		tools: [
			defineTool({
				name: SNAPSHOT_TOOL,
				description:
					"Write this conversation as the user sees it now (live branch only, in order) to a new file and return its path. Skills that read the conversation, such as show-me, take this file.",
				parameters: { type: "object", properties: {} },
				// A rerun after a restart writes a fresh snapshot from the committed store.
				replay: "safe",
				execute: async (_input: unknown, api: ToolExecutionApi, context: Context) => {
					const path = await writeSnapshot(folder, pageSize, api, context);
					return { output: [{ type: "text", text: path }] };
				},
			}),
		],
	});
}

async function writeSnapshot(folder: string, pageSize: number, api: ToolExecutionApi, context: Context): Promise<string> {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const temporary = join(folder, `.tmp-${process.pid}-${api.callId.replace(/[^\w-]/g, "_")}`);
	// One commit is one consistent read of the fork-aware visible range; each page is written as it arrives, so one page
	// is in memory at a time. The file is opened inside the callback, so a commit that reruns starts the file again.
	const last = await api.commit(async (tx) => {
		const fd = openSync(temporary, "w", 0o600);
		try {
			let lastId = 0;
			let cursor: Parameters<typeof tx.scanEntries>[2];
			do {
				const page = await tx.scanEntries({ conversationId: api.conversationId, order: "ascending" }, pageSize, cursor);
				const text = page.items.map((entry) => `${JSON.stringify({ entry })}\n`).join("");
				if (text.length > 0) writeSync(fd, text);
				if (page.items.length > 0) lastId = Number(page.items[page.items.length - 1]?.id);
				cursor = page.next;
			} while (cursor !== undefined);
			return lastId;
		} finally {
			closeSync(fd);
		}
	}, context);
	const path = join(folder, `${Number(api.conversationId)}-${last}.jsonl`);
	renameSync(temporary, path);
	// One snapshot on disk: an earlier path now fails visibly instead of being read stale. Another live call's
	// temporary file (same pid) is left alone; a killed program's are removed.
	for (const name of readdirSync(folder)) {
		const full = join(folder, name);
		if (full === path || name.startsWith(`.tmp-${process.pid}-`)) continue;
		rmSync(full, { force: true });
	}
	return path;
}
