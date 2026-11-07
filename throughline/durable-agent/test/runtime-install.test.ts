import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, install, readPin, rollback } from "../install/runtime.ts";

/** A tiny stand-in for the Pi fork: one workspace package with dist, a node_modules link to it, the agent entry. */
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

test("install copies the program read-only and pins it; check sees an edit; rollback returns to the previous copy", () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const first = install(fork, runtime, null);
	assert.equal(readlinkSync(join(runtime, "current")), join("versions", first.id));
	const entry = join(runtime, "versions", first.id, "throughline/durable-agent/src/main.ts");
	assert.equal(statSync(entry).mode & 0o222, 0, "the installed entry is read-only");
	assert.equal(readlinkSync(join(runtime, "versions", first.id, "node_modules/@earendil-works/pi-durable")), "../../packages/durable");

	// An edit in the fork after install does not reach the installed copy.
	writeFileSync(join(fork, "throughline/durable-agent/src/main.ts"), 'console.log("edited");\n');
	const facts = check(runtime);
	assert.ok(!facts.problems.some((p) => p.includes("changed after install")), facts.problems.join("; "));

	// An edit to the installed copy itself is caught.
	chmodSync(entry, 0o644);
	writeFileSync(entry, 'console.log("tampered");\n');
	const tampered = check(runtime);
	assert.ok(tampered.problems.some((p) => p.includes("changed after install")));
	assert.ok(tampered.problems.some((p) => p.includes("writable again")));

	// A dirty fork is refused; a second clean install records the first as previous; rollback returns to it.
	assert.throws(() => install(fork, runtime, null), /uncommitted changes/);
	execFileSync("git", ["-C", fork, "checkout", "--", "."]);
	const second = install(fork, runtime, null);
	assert.equal(second.previous, first.id);
	assert.equal(rollback(runtime).id, first.id);
	assert.equal(readPin(runtime)?.id, first.id);
});
