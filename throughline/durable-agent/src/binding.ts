// The store's binding: which agent the store belongs to, so a program started for another agent refuses it. Which
// conversation a thread shows is not here: ThroughLine's provider thread names it, and every call carries it.

import { defineDoc } from "@earendil-works/pi-durable";

// Stores written before protocol 3 also hold a conversationId field; nothing reads it, and the version stays 1 because
// Durable migrates a document only on a version change.
export type StoredBinding = { agentId: string | null };

/** The binding document, one per store, written in the root conversation's creating commit. */
export const Binding = defineDoc<StoredBinding>({
	kind: "throughline.agent-binding",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({ agentId: null }),
});
