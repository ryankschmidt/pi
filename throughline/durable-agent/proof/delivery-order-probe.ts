// One-off delivery-order probe on this Mac (build round 6): the agent installer against the shipped show-me and
// subscription-images (refused until the new versions ship) and against their Tier 1 builds (installs). It needs the
// Mac's shipped and Tier 1 copies, so it is a proof script, not a fork test.
//   node proof/delivery-order-probe.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { install, SHIPPED_IMAGE_MODULE, SHIPPED_SHOW_ME } from "../install/runtime.ts";

const TIER1_SHOW_ME = join(homedir(), "core-root/vault/01_Projects/workbench/tools/show-me/show-me.md");
const TIER1_IMAGES = join(homedir(), "core-root/vault/01_Projects/workbench/tools/subscription-images/dist");

function fakeFork(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-"));
	const file = (rel: string, body: string) => {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), body);
	};
	file("package.json", '{"name":"pi-monorepo","private":true}');
	file("packages/durable/package.json", '{"name":"@earendil-works/pi-durable"}');
	file("packages/durable/dist/index.js", "export const x = 1;\n");
	file("throughline/durable-agent/package.json", '{"name":"agent"}');
	file("throughline/durable-agent/src/main.ts", 'console.log("agent");\n');
	mkdirSync(join(root, "node_modules/@earendil-works"), { recursive: true });
	symlinkSync("../../packages/durable", join(root, "node_modules/@earendil-works/pi-durable"));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "package.json", "throughline", "packages/durable/package.json");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fork");
	return root;
}

const cases: [string, string, string][] = [
	["shipped show-me (today) + Tier 1 images", SHIPPED_SHOW_ME, TIER1_IMAGES],
	["Tier 1 show-me 2.0.8 + shipped images (today)", TIER1_SHOW_ME, SHIPPED_IMAGE_MODULE],
	["Tier 1 show-me 2.0.8 + Tier 1 images 0.2.6", TIER1_SHOW_ME, TIER1_IMAGES],
];
for (const [label, showMe, imageModule] of cases) {
	try {
		const pin = await install(fakeFork(), mkdtempSync(join(tmpdir(), "pi-runtime-")), null, { showMe, imageModule });
		console.log(`INSTALLED  ${label}: ${pin.id}`);
	} catch (error) {
		console.log(`REFUSED    ${label}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
	}
}
