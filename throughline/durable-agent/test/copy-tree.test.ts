import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyTree } from "../install/copy-tree.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// Rereview9-3 #1: the installer's `cp -cR` is refused by GNU cp on the tower and mgr. Its replacement must keep what the
// install relies on: workspace links stay relative and resolve inside the copy, bytes and modes are copied, a later edit
// in the source never reaches the copy, and an existing target is never overwritten.
test("copyTree keeps relative links pointing inside the copy, copies bytes and modes, and never writes over a target", () => {
	const root = mkdtempSync(join(tmpdir(), "copy-tree-"));
	roots.push(root);
	const fork = join(root, "fork");
	mkdirSync(join(fork, "packages/durable/dist"), { recursive: true });
	writeFileSync(join(fork, "packages/durable/dist/index.js"), "export const v = 1;\n");
	writeFileSync(join(fork, "packages/durable/dist/cli.js"), "#!/usr/bin/env node\n");
	chmodSync(join(fork, "packages/durable/dist/cli.js"), 0o755);
	mkdirSync(join(fork, "node_modules/@earendil-works"), { recursive: true });
	symlinkSync("../../packages/durable", join(fork, "node_modules/@earendil-works/pi-durable"));
	const version = join(root, "versions/one");
	mkdirSync(version, { recursive: true });
	for (const path of ["node_modules", "packages"]) copyTree(join(fork, path), join(version, path));

	const link = join(version, "node_modules/@earendil-works/pi-durable");
	assert.equal(readlinkSync(link), "../../packages/durable", "the link text is unchanged");
	assert.equal(realpathSync(link), realpathSync(join(version, "packages/durable")), "the link resolves inside the copy, not the fork");
	assert.equal(statSync(join(version, "packages/durable/dist/cli.js")).mode & 0o777, 0o755);
	writeFileSync(join(fork, "packages/durable/dist/index.js"), "export const v = 2;\n");
	assert.equal(readFileSync(join(version, "packages/durable/dist/index.js"), "utf8"), "export const v = 1;\n", "a later source edit never reaches the copy");
	assert.throws(() => copyTree(join(fork, "packages"), join(version, "packages")), /exist/i);
});
