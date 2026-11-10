// The thread's binding: which conversation the agent's ThroughLine thread shows now (the root, or the newest fork
// after a rewind). The program writes it on every bind; conversation_snapshot reads it to write only that branch.

import { defineDoc } from "@earendil-works/pi-durable";

export type StoredBinding = { agentId: string | null; conversationId: number | null };

/** The binding document, one per store. */
export const Binding = defineDoc<StoredBinding>({
	kind: "throughline.agent-binding",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({ agentId: null, conversationId: null }),
});
