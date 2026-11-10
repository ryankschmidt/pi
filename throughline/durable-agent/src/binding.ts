// The thread's binding: which conversation the agent's ThroughLine thread shows now (the root, or the newest fork
// after a rewind). The program writes it on every bind and serves that conversation to ThroughLine and the read socket.

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
