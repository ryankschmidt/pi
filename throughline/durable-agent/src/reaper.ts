// Stops the commands a killed agent program leaves running.
// Pi Durable starts each bash command detached, in its own process group, so a SIGKILL of the program does not reach
// them. Two parts close that gap without touching Pi Durable:
//   1. A watcher process, started by the program in its own process group, lists the program's direct children every
//      200 ms and records their process groups in <store>/children.json. When the program is gone it kills every
//      recorded group and exits.
//   2. On start, the program kills any group still listed in children.json by an earlier program (the watcher itself
//      may have been killed with it).
// Limit: a command started and orphaned within one 200 ms tick is not seen.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TICK_MS = 200;
export const CHILDREN_FILE = "children.json";

type Recorded = { programPid: number; groups: number[] };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Direct children of `pid` with their process group ids, from `ps`. */
export function childGroups(pid: number): number[] {
	let out: string;
	try {
		out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
	} catch {
		return [];
	}
	const groups = new Set<number>();
	for (const line of out.split("\n")) {
		const [child, parent, group] = line.trim().split(/\s+/).map(Number);
		if (parent === pid && child !== undefined && group !== undefined && group === child) groups.add(group);
	}
	return [...groups];
}

function killGroups(groups: Iterable<number>): number {
	let killed = 0;
	for (const group of groups) {
		if (group <= 1 || group === process.pid) continue;
		try {
			process.kill(-group, "SIGKILL");
			killed++;
		} catch {}
	}
	return killed;
}

function write(file: string, recorded: Recorded): void {
	writeFileSync(`${file}.tmp`, JSON.stringify(recorded));
	renameSync(`${file}.tmp`, file);
}

/** At program start: kill groups an earlier program left behind, then forget them. */
export function reapLeftovers(storeDir: string): number {
	const file = join(storeDir, CHILDREN_FILE);
	if (!existsSync(file)) return 0;
	let recorded: Recorded | undefined;
	try {
		recorded = JSON.parse(readFileSync(file, "utf8")) as Recorded;
	} catch {}
	const killed = recorded && recorded.programPid !== process.pid ? killGroups(recorded.groups) : 0;
	write(file, { programPid: process.pid, groups: [] });
	return killed;
}

/** Start the watcher for this program. It runs in its own group, so killing the program's group spares it. */
export function startReaper(storeDir: string): void {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch", String(process.pid), storeDir], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

/** The watcher's loop. */
function watch(programPid: number, storeDir: string): void {
	const file = join(storeDir, CHILDREN_FILE);
	const groups = new Set<number>();
	const timer = setInterval(() => {
		if (!alive(programPid)) {
			clearInterval(timer);
			killGroups(groups);
			try {
				write(file, { programPid, groups: [] });
			} catch {}
			process.exit(0);
		}
		const now = childGroups(programPid).filter((group) => group !== process.pid);
		// Groups whose leader exited are dropped; their remaining members are killed only if the program dies first.
		const changed = now.some((group) => !groups.has(group));
		for (const group of now) groups.add(group);
		for (const group of [...groups]) {
			if (!now.includes(group)) {
				try {
					process.kill(-group, 0);
				} catch {
					groups.delete(group);
				}
			}
		}
		if (changed) {
			try {
				write(file, { programPid, groups: [...groups] });
			} catch {}
		}
	}, TICK_MS);
}

if (process.argv[2] === "--watch") watch(Number(process.argv[3]), String(process.argv[4]));
