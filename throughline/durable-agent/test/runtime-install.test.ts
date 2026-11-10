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

const IMAGE_TOOLS = ["generate_image", "edit_image", "inspect_image"];

/** A stand-in for the shipped subscription-images folder exporting the contract for `tools` (all three by default). */
function fakeImageModule(tools: string[] = IMAGE_TOOLS, schemas: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-images-"));
	const descriptions = Object.fromEntries(tools.map((name) => [name, `The ${name} tool`]));
	const parameters = Object.fromEntries(tools.map((name) => [name, schemas[name] ?? { type: "object", properties: {} }]));
	writeFileSync(
		join(dir, "shared.mjs"),
		`export const imageToolDescriptions = ${JSON.stringify(descriptions)};\nexport const imageToolParameters = ${JSON.stringify(parameters)};\n`,
	);
	writeFileSync(join(dir, "effects.mjs"), "export const runImageTool = () => undefined;\n");
	return dir;
}

/** A stand-in for the shipped show-me.md: a command-only skill named show-me. */
function fakeShowMe(body = "Show it."): string {
	const file = join(mkdtempSync(join(tmpdir(), "pi-show-me-")), "show-me.md");
	writeFileSync(file, `---\nname: show-me\ndescription: Show the work.\ndisable-model-invocation: true\n---\n${body}\n`);
	return file;
}

test("install copies the program read-only and pins it; check sees an edit; rollback returns to the previous copy", async () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const imageModule = fakeImageModule();
	const showMe = fakeShowMe();
	const first = await install(fork, runtime, null, { imageModule, showMe });
	assert.equal(readlinkSync(join(runtime, "current")), join("versions", first.id));
	const entry = join(runtime, "versions", first.id, "throughline/durable-agent/src/main.ts");
	assert.equal(statSync(entry).mode & 0o222, 0, "the installed entry is read-only");
	assert.equal(readlinkSync(join(runtime, "versions", first.id, "node_modules/@earendil-works/pi-durable")), "../../packages/durable");

	// An edit in the fork after install does not reach the installed copy.
	writeFileSync(join(fork, "throughline/durable-agent/src/main.ts"), 'console.log("edited");\n');
	const facts = check(runtime, imageModule, showMe);
	assert.ok(!facts.problems.some((p) => p.includes("changed after install")), facts.problems.join("; "));

	// An edit to the installed copy itself is caught.
	chmodSync(entry, 0o644);
	writeFileSync(entry, 'console.log("tampered");\n');
	const tampered = check(runtime, imageModule, showMe);
	assert.ok(tampered.problems.some((p) => p.includes("changed after install")));
	assert.ok(tampered.problems.some((p) => p.includes("writable again")));

	// A dirty fork is refused; a second clean install records the first as previous; rollback returns to it.
	await assert.rejects(install(fork, runtime, null, { imageModule, showMe }), /uncommitted changes/);
	execFileSync("git", ["-C", fork, "checkout", "--", "."]);
	const second = await install(fork, runtime, null, { imageModule, showMe });
	assert.equal(second.previous, first.id);
	assert.equal(rollback(runtime).id, first.id);
	assert.equal(readPin(runtime)?.id, first.id);
});

test("the image module is pinned inside the install: missing or incompatible refuses, present is read-only, a newer ship is reported", async () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const showMe = fakeShowMe();
	const missing = mkdtempSync(join(tmpdir(), "pi-images-missing-"));
	await assert.rejects(install(fork, runtime, null, { imageModule: missing, showMe }), /lacks shared\.mjs, effects\.mjs; current is unchanged/);
	assert.equal(existsSync(join(runtime, "current")), false);
	// Both files present and loadable, exporting the wrong names: refused before current moves.
	const wrong = mkdtempSync(join(tmpdir(), "pi-images-wrong-"));
	writeFileSync(join(wrong, "shared.mjs"), "export const unrelated = 1;\n");
	writeFileSync(join(wrong, "effects.mjs"), "export const alsoUnrelated = 2;\n");
	await assert.rejects(install(fork, runtime, null, { imageModule: wrong, showMe }), /imageToolDescriptions is not an object\); the new copy is left unused at .*; current is unchanged/);
	assert.equal(existsSync(join(runtime, "current")), false);

	const imageModule = fakeImageModule();
	const pin = await install(fork, runtime, null, { imageModule, showMe });
	const copy = join(runtime, "versions", pin.id, "throughline/durable-agent/capabilities/subscription-images/effects.mjs");
	assert.equal(statSync(copy).mode & 0o222, 0, "the pinned image module is read-only");
	assert.ok(!check(runtime, imageModule, showMe).problems.some((p) => p.includes("image module")));

	// A copy missing any one of the three tools is refused and the installed version stays current.
	for (const lacking of IMAGE_TOOLS) {
		const partial = fakeImageModule(IMAGE_TOOLS.filter((name) => name !== lacking));
		await assert.rejects(install(fork, runtime, null, { imageModule: partial, showMe }), new RegExp(`the copy lacks ${lacking}\\); the new copy is left unused`));
		assert.equal(readPin(runtime)?.id, pin.id, `current is unchanged after a copy without ${lacking}`);
	}
	await assert.rejects(install(fork, runtime, null, { imageModule: fakeImageModule([...IMAGE_TOOLS, "erase_image"]), showMe }), /does not know: erase_image/);
	// Nested schemas are checked whole: an unknown type and a string `required` compile in pi's schema compiler, a
	// property given as a number does not; all three are refused before current moves.
	const nested: [unknown, RegExp][] = [
		[{ type: "object", properties: { prompt: { type: "not-a-json-schema-type" } } }, /properties\.prompt has type "not-a-json-schema-type"/],
		[{ type: "object", properties: { prompt: { type: "string" } }, required: "prompt" }, /required is not a list of names/],
		[{ type: "object", properties: { prompt: 5 } }, /properties\.prompt is neither a schema object nor a boolean/],
	];
	for (const [schema, reason] of nested) {
		await assert.rejects(install(fork, runtime, null, { imageModule: fakeImageModule(IMAGE_TOOLS, { generate_image: schema }), showMe }), reason);
		assert.equal(readPin(runtime)?.id, pin.id);
	}
	// The check runs on the copied files: this source loads only beside a file the install does not copy.
	const leaning = fakeImageModule();
	writeFileSync(join(leaning, "helper.mjs"), "export const ready = true;\n");
	writeFileSync(join(leaning, "effects.mjs"), 'import "./helper.mjs";\nexport const runImageTool = () => undefined;\n');
	await assert.rejects(install(fork, runtime, null, { imageModule: leaning, showMe }), /did not load .*helper\.mjs[\s\S]*current is unchanged/);
	assert.equal(readPin(runtime)?.id, pin.id);

	writeFileSync(join(imageModule, "effects.mjs"), "export const runImageTool = () => 'newer';\n");
	assert.ok(check(runtime, imageModule, showMe).problems.includes("image module pinned older than shipped; the next agent install picks it up"));
	assert.ok(!check(runtime, imageModule, showMe).problems.some((p) => p.includes("changed after install")), "the pin itself is unchanged");
});

test("the show-me skill is pinned inside the install: missing or model-callable refuses, a newer ship is reported", async () => {
	const fork = fakeFork();
	const runtime = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const imageModule = fakeImageModule();
	await assert.rejects(
		install(fork, runtime, null, { imageModule, showMe: join(tmpdir(), "no-such-show-me.md") }),
		/show-me skill is missing at .*; current is unchanged/,
	);
	const modelCallable = fakeShowMe();
	writeFileSync(modelCallable, "---\nname: show-me\ndescription: Show the work.\n---\nShow it.\n");
	await assert.rejects(install(fork, runtime, null, { imageModule, showMe: modelCallable }), /not marked disable-model-invocation/);
	assert.equal(existsSync(join(runtime, "current")), false);

	const showMe = fakeShowMe();
	const pin = await install(fork, runtime, null, { imageModule, showMe });
	const copy = join(runtime, "versions", pin.id, "throughline/durable-agent/capabilities/skills/show-me/SKILL.md");
	assert.equal(statSync(copy).mode & 0o222, 0, "the pinned skill is read-only");
	assert.ok(!check(runtime, imageModule, showMe).problems.some((p) => p.includes("show-me")));
	writeFileSync(showMe, "---\nname: show-me\ndescription: Show the work.\ndisable-model-invocation: true\n---\nShow it better.\n");
	assert.ok(check(runtime, imageModule, showMe).problems.includes("show-me skill pinned older than shipped; the next agent install picks it up"));
});

test("check run through a link (as the Health Hub adapter runs it) reports a missing install and exits 1", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-link-"));
	symlinkSync(fileURLToPath(new URL("../install/runtime.ts", import.meta.url)), join(dir, "runtime.ts"));
	const run = spawnSync(process.execPath, [join(dir, "runtime.ts"), "check", "--runtime", join(dir, "empty")], { encoding: "utf8" });
	assert.equal(run.status, 1, run.stderr);
	assert.match(run.stdout, /REGRESSED/);
	assert.match(run.stdout, /no installed agent program/);
});
