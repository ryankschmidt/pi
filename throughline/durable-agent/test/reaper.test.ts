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

/** Wait until `ready` holds, up to `ms`: the watcher is a separate Node process, so its start and first tick take as long as the machine makes them. */
async function until(ready: () => boolean, ms = 20_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}
const recorded = (store: string): number[] | undefined => {
	try {
		return (JSON.parse(readFileSync(join(store, "children.json"), "utf8")) as { groups: number[] }).groups;
	} catch {
		return undefined;
	}
};

// Rereview11-1, 11-2: fixed sleeps (700 ms, 800 ms) assumed the watcher started and ticked in time; under a full run it
// had not (children.json absent), and the failed assertion left the parent running, which held the suite open. The
// test now waits for each condition with a deadline and always stops the parent.
test("a SIGKILLed program's detached command is stopped by its watcher", async () => {
	const store = mkdtempSync(join(tmpdir(), "reaper-"));
	const parent = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/detached-parent.ts", import.meta.url)), store], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	try {
		const shellPid = await new Promise<number>((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
		assert.ok(await until(() => recorded(store)?.includes(shellPid) === true), "the watcher records the detached shell's group");
		assert.ok(alive(shellPid));
		parent.kill("SIGKILL");
		assert.ok(await until(() => !alive(shellPid)), "the detached shell outlived its killed program");
		assert.equal(existsSync(join(store, "late.txt")), false);
	} finally {
		parent.kill("SIGKILL");
	}
});

test("a new program stops groups an earlier one recorded", async () => {
	const store = mkdtempSync(join(tmpdir(), "reaper-"));
	const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	orphan.unref();
	writeFileSync(join(store, "children.json"), JSON.stringify({ programPid: 999999, groups: [orphan.pid] }));
	assert.equal(reapLeftovers(store), 1);
	assert.ok(await until(() => !alive(orphan.pid as number)), "the recorded group is stopped");
	assert.deepEqual(JSON.parse(readFileSync(join(store, "children.json"), "utf8")).groups, []);
});
