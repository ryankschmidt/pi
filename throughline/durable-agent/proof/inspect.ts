// Open an agent store through the program and print its status, live state and entries, then stop.
//   PI_CODING_AGENT_DIR=<agent dir> node proof/inspect.ts <store dir> <agent id> <cwd>
import { fileURLToPath } from "node:url";
import { startProgram } from "../src/client.ts";

const [store, agent, cwd] = process.argv.slice(2) as [string, string, string];
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const program = startProgram(process.execPath, [main, "--store", store, "--agent", agent, "--cwd", cwd], {
	env: process.env,
});
let view: unknown;
program.onView((v) => {
	view = v.value;
});
try {
	console.log(JSON.stringify({ hello: await program.hello }));
	console.log(JSON.stringify({ status: await program.call("status") }));
	await program.call("watch");
	await new Promise((r) => setTimeout(r, 300));
	const docs = (view as { docs?: Record<string, unknown> })?.docs ?? {};
	console.log(JSON.stringify({ live: docs["pi.live"], inbox: docs["pi.inbox"] }).slice(0, 3000));
	const page = (await program.call("entries", { limit: 200 })) as { items: { id: number; kind: string; model?: unknown[] }[] };
	for (const entry of page.items) console.log(JSON.stringify(entry).slice(0, 600));
	await program.call("drain");
} finally {
	await program.exited;
	process.stderr.write(program.stderr().slice(-3000));
}
