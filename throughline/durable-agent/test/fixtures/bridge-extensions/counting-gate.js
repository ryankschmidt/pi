// A Pi extension for the bridge tests: blocks bash, rewrites echo commands, counts its checks, and uses Pi APIs the
// bridge does not map (a renderer, a session_compact handler, pi.sendMessage, ctx.model).
export default function (pi) {
	globalThis.countingGateChecks = 0;
	pi.on("tool_call", (event, ctx) => {
		globalThis.countingGateChecks += 1;
		void ctx.model;
		if (event.toolName === "bash" && String(event.input.command).includes("rm ")) return { block: true, reason: "no rm" };
		if (event.toolName === "bash") event.input.command = `${event.input.command} # checked`;
		return undefined;
	});
	pi.on("session_compact", () => pi.sendMessage({ customType: "x", content: "after", display: true }));
	pi.registerMessageRenderer("x", () => undefined);
	pi.registerCommand("gate-status", {
		description: "Report the gate's check count",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`checks ${globalThis.countingGateChecks}`, "info");
		},
	});
}
