// Build round 10 probe (Rereview9-3 #1): run the installer's copy step for real on a host, in a scratch folder, on a
// tree shaped like the install (workspace packages, node_modules with relative workspace links, an executable file).
// Step 1 runs the old step (`cp -cR`); step 2 runs install/copy-tree.ts. Node only: copy this file and
// install/copy-tree.ts to the host keeping their folders, then:  node proof/linux-copy-probe.ts <scratch folder>
// Nothing outside the scratch folder is touched; it is removed at the end.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { copyTree } from "../install/copy-tree.ts";

const scratch = mkdtempSync(join(process.argv[2] ?? ".", "copy-probe-"));
const fork = join(scratch, "fork");
mkdirSync(join(fork, "packages/durable/dist"), { recursive: true });
writeFileSync(join(fork, "packages/durable/dist/index.js"), "export const v = 1;\n");
writeFileSync(join(fork, "packages/durable/dist/cli.js"), "#!/usr/bin/env node\n");
chmodSync(join(fork, "packages/durable/dist/cli.js"), 0o755);
mkdirSync(join(fork, "node_modules/@earendil-works"), { recursive: true });
symlinkSync("../../packages/durable", join(fork, "node_modules/@earendil-works/pi-durable"));
mkdirSync(join(fork, "throughline/durable-agent/src"), { recursive: true });
writeFileSync(join(fork, "throughline/durable-agent/src/main.ts"), "// main\n");
writeFileSync(join(fork, "package.json"), "{}\n");
const COPIED = ["package.json", "node_modules", "packages", "throughline/durable-agent"];
const cpVersion = (() => {
	try {
		return execFileSync("cp", ["--version"], { encoding: "utf8", stdio: "pipe" }).split("\n")[0];
	} catch {
		return "BSD cp (no --version)";
	}
})();
console.log(`host ${hostname()} · node ${process.version} · ${cpVersion}`);

const old = join(scratch, "versions/old");
mkdirSync(join(old, "throughline"), { recursive: true });
try {
	for (const path of COPIED) execFileSync("cp", ["-cR", join(fork, path), join(old, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")], { stdio: "pipe" });
	console.log("step 1, old `cp -cR`: copied");
} catch (error) {
	console.log(`step 1, old \`cp -cR\`: REFUSED: ${String((error as { stderr?: Buffer }).stderr ?? error).trim().split("\n")[0]}`);
}

const next = join(scratch, "versions/new");
mkdirSync(join(next, "throughline"), { recursive: true });
for (const path of COPIED) copyTree(join(fork, path), join(next, path));
const link = join(next, "node_modules/@earendil-works/pi-durable");
const checks = {
	"link text unchanged": readlinkSync(link) === "../../packages/durable",
	"link resolves inside the copy": realpathSync(link) === realpathSync(join(next, "packages/durable")),
	"executable mode kept": (statSync(join(next, "packages/durable/dist/cli.js")).mode & 0o777) === 0o755,
	"entry copied": readFileSync(join(next, "throughline/durable-agent/src/main.ts"), "utf8") === "// main\n",
};
writeFileSync(join(fork, "packages/durable/dist/index.js"), "export const v = 2;\n");
Object.assign(checks, { "later source edit does not reach the copy": readFileSync(join(next, "packages/durable/dist/index.js"), "utf8") === "export const v = 1;\n" });
let refusedOverwrite = false;
try {
	copyTree(join(fork, "packages"), join(next, "packages"));
} catch {
	refusedOverwrite = true;
}
Object.assign(checks, { "existing target never overwritten": refusedOverwrite });
for (const [name, ok] of Object.entries(checks)) console.log(`step 2, copyTree: ${ok ? "PASS" : "FAIL"} ${name}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
