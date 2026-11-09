import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

/** A stand-in for the shipped subscription-images folder. */
function fakeImageModule(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-images-"));
	writeFileSync(join(dir, "shared.mjs"), "export const imageToolDescriptions = {};\n");
	writeFileSync(join(dir, "effects.mjs"), "export const runImageTool = () => undefined;\n");
	return dir;
}

test("install copies the program read-only and pins it; check sees an edit; rollback returns to the previous copy", () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const imageModule = fakeImageModule();
	const first = install(fork, runtime, null, { imageModule });
	assert.equal(readlinkSync(join(runtime, "current")), join("versions", first.id));
	const entry = join(runtime, "versions", first.id, "throughline/durable-agent/src/main.ts");
	assert.equal(statSync(entry).mode & 0o222, 0, "the installed entry is read-only");
	assert.equal(readlinkSync(join(runtime, "versions", first.id, "node_modules/@earendil-works/pi-durable")), "../../packages/durable");

	// An edit in the fork after install does not reach the installed copy.
	writeFileSync(join(fork, "throughline/durable-agent/src/main.ts"), 'console.log("edited");\n');
	const facts = check(runtime, imageModule);
	assert.ok(!facts.problems.some((p) => p.includes("changed after install")), facts.problems.join("; "));

	// An edit to the installed copy itself is caught.
	chmodSync(entry, 0o644);
	writeFileSync(entry, 'console.log("tampered");\n');
	const tampered = check(runtime, imageModule);
	assert.ok(tampered.problems.some((p) => p.includes("changed after install")));
	assert.ok(tampered.problems.some((p) => p.includes("writable again")));

	// A dirty fork is refused; a second clean install records the first as previous; rollback returns to it.
	assert.throws(() => install(fork, runtime, null, { imageModule }), /uncommitted changes/);
	execFileSync("git", ["-C", fork, "checkout", "--", "."]);
	const second = install(fork, runtime, null, { imageModule });
	assert.equal(second.previous, first.id);
	assert.equal(rollback(runtime).id, first.id);
	assert.equal(readPin(runtime)?.id, first.id);
});

test("the image module is pinned inside the install: missing refuses, present is read-only, a newer ship is reported", () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const missing = mkdtempSync(join(tmpdir(), "pi-images-missing-"));
	assert.throws(() => install(fork, runtime, null, { imageModule: missing }), /lacks shared\.mjs, effects\.mjs; current is unchanged/);
	assert.equal(existsSync(join(runtime, "current")), false);

	const imageModule = fakeImageModule();
	const pin = install(fork, runtime, null, { imageModule });
	const copy = join(runtime, "versions", pin.id, "throughline/durable-agent/capabilities/subscription-images/effects.mjs");
	assert.equal(statSync(copy).mode & 0o222, 0, "the pinned image module is read-only");
	assert.ok(!check(runtime, imageModule).problems.some((p) => p.includes("image module")));

	writeFileSync(join(imageModule, "effects.mjs"), "export const runImageTool = () => 'newer';\n");
	assert.ok(check(runtime, imageModule).problems.includes("image module pinned older than shipped; the next agent install picks it up"));
	assert.ok(!check(runtime, imageModule).problems.some((p) => p.includes("changed after install")), "the pin itself is unchanged");
});

test("check run through a link (as the Health Hub adapter runs it) reports a missing install and exits 1", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-link-"));
	symlinkSync(fileURLToPath(new URL("../install/runtime.ts", import.meta.url)), join(dir, "runtime.ts"));
	const run = spawnSync(process.execPath, [join(dir, "runtime.ts"), "check", "--runtime", join(dir, "empty")], { encoding: "utf8" });
	assert.equal(run.status, 1, run.stderr);
	assert.match(run.stdout, /REGRESSED/);
	assert.match(run.stdout, /no installed agent program/);
});
