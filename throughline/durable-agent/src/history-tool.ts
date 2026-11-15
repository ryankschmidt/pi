// search_history as a native Durable tool: the thin add-on over history.ts. Durable keeps every entry of a
// conversation, also those a compaction summary replaced (the fork-aware history `Tx.scanEntries` pages), so after a
// compaction the agent reaches its earlier work here instead of trusting the summary alone. It only reads committed
// entries and keeps no state, so it is replay-safe: a restart mid-call reads again and changes nothing.

import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type HistoryQuery, lastReset, SEARCH_HISTORY_TOOL, searchHistory, type WireEntry } from "./history.ts";

const PAGE = 500;

const DESCRIPTION =
	"Search your own full stored history, including entries from before a reset, handoff or compaction that you can no longer see. Filter by words (query), by tool name (tool), by entry kind, or by entry number range (from_entry, to_entry). Pass entry to read one entry in full by its number. Results come newest first (order oldest to reverse) and are paged with limit and offset; use next_offset for the next page. Each result says whether the entry is active, compacted or before reset.";

const PARAMETERS = {
	type: "object",
	properties: {
		query: { type: "string", description: "Words that must all appear, case-insensitive." },
		tool: { type: "string", description: "Only calls to and results from this tool, for example bash." },
		entry: { type: "integer", minimum: 1, description: "Read this one entry in full." },
		kind: { type: "string", enum: ["user", "assistant", "tool_call", "tool_result", "event"] },
		from_entry: { type: "integer", minimum: 1, description: "Oldest entry number to include." },
		to_entry: { type: "integer", minimum: 1, description: "Newest entry number to include." },
		order: { type: "string", enum: ["newest", "oldest"] },
		limit: { type: "integer", minimum: 1, maximum: 50, description: "Results per page. Default 10." },
		offset: { type: "integer", minimum: 0, description: "Results to skip. Default 0." },
	},
	additionalProperties: false,
} as const;

export function createHistoryExtension(): Extension {
	return defineExtension({
		name: "history",
		tools: [
			defineTool({
				name: SEARCH_HISTORY_TOOL,
				description: DESCRIPTION,
				parameters: PARAMETERS,
				replay: "safe",
				execute: async (input: unknown, api: ToolExecutionApi, context: Context) => {
					const { entries, activeFrom } = await api.commit(async (tx) => {
						const all: EntryRecord[] = [];
						let page = await tx.scanEntries({ conversationId: api.conversationId }, PAGE);
						all.push(...page.items);
						while (page.next !== undefined) {
							page = await tx.scanEntries({ conversationId: api.conversationId }, PAGE, page.next);
							all.push(...page.items);
						}
						const marker = await tx.latestHeadMarker(api.conversationId);
						return { entries: all, activeFrom: marker?.head as number | undefined };
					}, context);
					const wire = entries as unknown as WireEntry[];
					const reset = lastReset(wire);
					const page = searchHistory(wire, input as HistoryQuery, {
						...(activeFrom === undefined ? {} : { activeFrom }),
						...(reset === undefined ? {} : { lastReset: reset }),
					});
					return { output: [{ type: "text", text: JSON.stringify(page) }] };
				},
			}),
		],
	});
}
