import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reapLeftovers } from "../src/reaper.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a SIGKILLed program's detached command is stopped by its watcher", async () => {
	const store = mkdtempSync(join(tmpdir(), "reaper-"));
	const parent = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/detached-parent.ts", import.meta.url)), store], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const shellPid = await new Promise<number>((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
	await sleep(700); // at least one watcher tick after the shell started
	assert.ok(alive(shellPid));
	assert.deepEqual(JSON.parse(readFileSync(join(store, "children.json"), "utf8")).groups, [shellPid]);
	parent.kill("SIGKILL");
	await sleep(800);
	assert.equal(alive(shellPid), false, "the detached shell outlived its killed program");
	assert.equal(existsSync(join(store, "late.txt")), false);
});

test("a new program stops groups an earlier one recorded", async () => {
	const store = mkdtempSync(join(tmpdir(), "reaper-"));
	const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	orphan.unref();
	writeFileSync(join(store, "children.json"), JSON.stringify({ programPid: 999999, groups: [orphan.pid] }));
	assert.equal(reapLeftovers(store), 1);
	await sleep(200);
	assert.equal(alive(orphan.pid as number), false);
	assert.deepEqual(JSON.parse(readFileSync(join(store, "children.json"), "utf8")).groups, []);
});
