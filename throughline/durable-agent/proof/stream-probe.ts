// Print one line per view while a long answer streams: time, live keys, and how much partial text is shown.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/stream-probe.ts <store dir> <cwd> [model]
import { fileURLToPath } from "node:url";
import { startProgram } from "../src/client.ts";

const [store, cwd, model = "anthropic/claude-opus-5-5"] = process.argv.slice(2) as [string, string, string?];
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const program = startProgram(process.execPath, [main, "--store", store, "--agent", "probe", "--cwd", cwd, "--model", model], {
	env: process.env,
});
await program.hello;
const t0 = Date.now();
program.onView((view) => {
	const value = view.value as { docs?: Record<string, any>; entries?: { kind: string }[] };
	const live = value.docs?.["pi.live"] ?? {};
	const content = (live.generation?.message?.content ?? []) as { type: string; text?: string }[];
	const chars = content.map((c) => c.text ?? "").join("").length;
	console.log(
		`${Date.now() - t0}ms live=${Object.keys(live).join(",")} gen=${Object.keys(live.generation ?? {}).join(",")} partialChars=${chars} entries=${value.entries?.length} ops=${JSON.stringify(view.ops ?? null).length}`,
	);
});
await program.call("watch");
const { submissionId } = (await program.call("submit", {
	content: process.env.PROBE_PROMPT ?? "Count from 1 to 120, one number per line, each followed by one English word. No tools.",
})) as { submissionId: number };
await program.call("wait", { submissionId });
await program.call("drain");
await program.exited;
