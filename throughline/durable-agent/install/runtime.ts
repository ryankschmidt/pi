#!/usr/bin/env node
// Installs the Pi Durable agent program into a versioned, read-only runtime folder, and checks that the
// working setup is still in place (Nov 7, 2026).
//
// Live ThroughLine Pi threads start `ryan-pi agent`, which runs the agent program's main.ts. Running it from the
// Pi fork's working tree meant any edit, branch switch, rebuild or upstream fold there changed every live thread at
// its next start. This program copies what the agent program needs (its own folder, the workspace packages' built
// dist, node_modules) into <runtime>/versions/<id>/, makes it read-only, pins its hash, and points
// <runtime>/current at it. The launcher's agent path is <runtime>/current/throughline/durable-agent/src/main.ts.
//
//   node install/runtime.ts install  [--from <pi fork root>] [--runtime <dir>] [--throughline-commit <sha>]
//   node install/runtime.ts rollback [--runtime <dir>]
//   node install/runtime.ts check    [--runtime <dir>] [--service <health hub service json>] [--json]
//
// check exits 0 when everything holds, 1 when something regressed; with --service it writes a Health Hub row.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PIN_SCHEMA = "throughline.pi-durable-agent-pin.v1";
const HOME = homedir();
export const DEFAULT_RUNTIME = join(HOME, ".local/share/pi-durable-agent");
const DEFAULT_FROM = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = "throughline/durable-agent/src/main.ts";
const APP_ASAR = "/Applications/ThroughLine.app/Contents/Resources/app.asar";
const THROUGHLINE_FORK = join(HOME, "throughline");
const STATIC_CONFIG = join(HOME, ".local/state/ryan/fccl/static-shim-config.sh");
const LAUNCHER = join(HOME, ".local/bin/ryan-pi");
// Strings that exist only in ThroughLine's Pi Durable client (apps/server/src/throughline/pi/durable/).
const DURABLE_CLIENT_MARKERS = ["Pi Durable agent program exited", "routePiAdapter"];

/** What the copy holds: the top-level paths taken from the Pi fork root. */
const COPIED = ["package.json", "node_modules", "packages", "throughline/durable-agent"];
/** The program hash covers the code that runs: the agent program and every workspace package's dist. */
function programRoots(root: string): string[] {
	const roots = [join(root, "throughline/durable-agent/src"), join(root, "throughline/durable-agent/package.json")];
	for (const name of readdirSync(join(root, "packages")).sort()) {
		const dist = join(root, "packages", name, "dist");
		if (existsSync(dist)) roots.push(dist, join(root, "packages", name, "package.json"));
	}
	return roots;
}

export interface Pin {
	schema: typeof PIN_SCHEMA;
	id: string;
	installed_at: string;
	pi_fork: string;
	pi_commit: string;
	throughline_commit: string | null;
	program_sha256: string;
	program_files: number;
	tree_sha256: string;
	tree_files: number;
	entry: string;
	previous: string | null;
}

/** sha256 over sorted "relative path\0kind\0content-hash" lines; symlinks hash their link text. */
export function treeHash(base: string, roots: string[]): { sha256: string; files: number } {
	const lines: string[] = [];
	const walk = (path: string) => {
		const st = lstatSync(path);
		const rel = relative(base, path);
		if (st.isSymbolicLink()) lines.push(`${rel}\0l\0${readlinkSync(path)}`);
		else if (st.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
		else if (st.isFile()) lines.push(`${rel}\0f\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
	};
	for (const root of roots) if (existsSync(root)) walk(root);
	lines.sort();
	return { sha256: createHash("sha256").update(lines.join("\n")).digest("hex"), files: lines.length };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setWritable(path: string, writable: boolean): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return;
	if (st.isDirectory()) for (const name of readdirSync(path)) setWritable(join(path, name), writable);
	const mode = st.mode & 0o7777;
	chmodSync(path, writable ? mode | 0o200 : mode & ~0o222);
}

function pointCurrent(runtime: string, id: string): void {
	const tmp = join(runtime, `.current-${process.pid}`);
	rmSync(tmp, { force: true });
	symlinkSync(join("versions", id), tmp);
	renameSync(tmp, join(runtime, "current")); // atomic swap of the link
}

export function readPin(runtime: string): Pin | null {
	const file = join(runtime, "current", "Pin.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Pin) : null;
}

export function install(from: string, runtime: string, throughlineCommit: string | null): Pin {
	const dirty = git(from, "status", "--porcelain", "--untracked-files=no");
	if (dirty) {
		throw new Error(
			`refused: the Pi fork at ${from} has uncommitted changes to tracked files:\n${dirty}\n` +
				"The installed agent program must be a commit on the fork's main, so a later build from main carries it. Commit or set them aside, then install again.",
		);
	}
	const branch = git(from, "rev-parse", "--abbrev-ref", "HEAD");
	if (branch !== "main") throw new Error(`refused: the Pi fork is on ${branch}; install only from main.`);
	const commit = git(from, "rev-parse", "HEAD");
	const previous = readPin(runtime)?.id ?? null;
	const id = `${commit.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const target = join(runtime, "versions", id);
	mkdirSync(join(target, "throughline"), { recursive: true });
	for (const path of COPIED) {
		// APFS clones: a later edit in the fork never reaches this copy.
		execFileSync("cp", ["-cR", join(from, path), join(target, dirname(path) === "." ? "" : dirname(path))]);
	}
	if (!existsSync(join(target, ENTRY))) throw new Error(`refused: the copy has no ${ENTRY}`);
	const program = treeHash(target, programRoots(target));
	const tree = treeHash(target, COPIED.map((p) => join(target, p)));
	const pin: Pin = {
		schema: PIN_SCHEMA,
		id,
		installed_at: new Date().toISOString(),
		pi_fork: from,
		pi_commit: commit,
		throughline_commit: throughlineCommit,
		program_sha256: program.sha256,
		program_files: program.files,
		tree_sha256: tree.sha256,
		tree_files: tree.files,
		entry: join(runtime, "current", ENTRY),
		previous,
	};
	writeFileSync(join(target, "Pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
	setWritable(target, false);
	pointCurrent(runtime, id);
	return pin;
}

export function rollback(runtime: string): Pin {
	const pin = readPin(runtime);
	if (!pin?.previous) throw new Error("refused: the current install names no previous version to go back to.");
	if (!existsSync(join(runtime, "versions", pin.previous, "Pin.json"))) {
		throw new Error(`refused: the previous version ${pin.previous} is missing from ${join(runtime, "versions")}.`);
	}
	pointCurrent(runtime, pin.previous);
	return readPin(runtime) as Pin;
}

export interface CheckResult {
	ok: boolean;
	problems: string[];
	facts: Record<string, unknown>;
}

function shellValue(file: string, name: string): string | null {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(new RegExp(`^\\s*${name}='([^']*)'`, "m"));
	return m ? m[1] : null;
}

export function check(runtime: string): CheckResult {
	const problems: string[] = [];
	const facts: Record<string, unknown> = {};
	const expectedEntry = join(runtime, "current", ENTRY);
	const pin = readPin(runtime);
	if (!pin) {
		problems.push(`no installed agent program at ${join(runtime, "current")}; live Pi threads cannot start from it`);
	} else {
		facts.version = pin.id;
		facts.pi_commit = pin.pi_commit;
		const versionDir = join(runtime, "versions", pin.id);
		const program = treeHash(versionDir, programRoots(versionDir));
		facts.program_sha256 = program.sha256;
		if (program.sha256 !== pin.program_sha256) {
			problems.push(`the installed agent program changed after install (hash ${program.sha256.slice(0, 12)}, pinned ${pin.program_sha256.slice(0, 12)})`);
		}
		if (statSync(join(versionDir, ENTRY)).mode & 0o222) problems.push("the installed agent program is writable again");
		try {
			git(pin.pi_fork, "merge-base", "--is-ancestor", pin.pi_commit, "main");
		} catch {
			problems.push(`the Pi fork's main no longer contains the installed commit ${pin.pi_commit.slice(0, 12)}`);
		}
		if (pin.throughline_commit) {
			try {
				git(THROUGHLINE_FORK, "merge-base", "--is-ancestor", pin.throughline_commit, "main");
			} catch {
				problems.push(`the ThroughLine fork's main no longer contains the installed server build ${pin.throughline_commit.slice(0, 12)}`);
			}
		}
	}
	const configured = shellValue(STATIC_CONFIG, "RYAN_FCCL_PI_DURABLE_AGENT");
	const embedded = shellValue(LAUNCHER, "EMBEDDED_PI_DURABLE_AGENT");
	facts.launcher_agent_path = configured;
	if (configured !== expectedEntry) problems.push(`the launcher's agent path is ${configured ?? "unset"}, expected ${expectedEntry}`);
	if (embedded !== expectedEntry) problems.push(`the launcher's built-in agent path is ${embedded ?? "unset"}, expected ${expectedEntry}`);
	if (!existsSync(APP_ASAR)) {
		problems.push(`ThroughLine is not installed at ${APP_ASAR}`);
	} else {
		const asar = readFileSync(APP_ASAR);
		const missing = DURABLE_CLIENT_MARKERS.filter((m) => asar.indexOf(m) < 0);
		facts.app_has_durable_client = missing.length === 0;
		if (missing.length) problems.push("the installed ThroughLine app lacks the Pi Durable client; Durable threads will not start");
	}
	return { ok: problems.length === 0, problems, facts };
}

function writeService(file: string, result: CheckResult): void {
	const row = {
		name: "pi-durable-guard",
		display_name: "Pi Durable setup",
		status: result.ok ? "ok" : "fail",
		message: result.ok
			? `holds · agent ${String(result.facts.version ?? "").slice(0, 12)} pinned and read-only · launcher path right · app has the Durable client`
			: `REGRESSED · ${result.problems.join(" · ")}`,
		timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		icon: "🧷",
	};
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(row, null, 2)}\n`);
	renameSync(tmp, file);
}

function main(): void {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			from: { type: "string", default: DEFAULT_FROM },
			runtime: { type: "string", default: DEFAULT_RUNTIME },
			"throughline-commit": { type: "string" },
			service: { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	const runtime = resolve(values.runtime as string);
	const verb = positionals[0];
	try {
		if (verb === "install") {
			const pin = install(resolve(values.from as string), runtime, (values["throughline-commit"] as string) ?? null);
			console.log(JSON.stringify(pin, null, 2));
		} else if (verb === "rollback") {
			console.log(JSON.stringify(rollback(runtime), null, 2));
		} else if (verb === "check") {
			const result = check(runtime);
			if (values.service) writeService(values.service as string, result);
			console.log(values.json ? JSON.stringify(result, null, 2) : result.ok ? "pi-durable-guard: holds" : `pi-durable-guard: REGRESSED\n- ${result.problems.join("\n- ")}`);
			process.exitCode = result.ok ? 0 : 1;
		} else {
			console.error("usage: runtime.ts install|rollback|check [--runtime <dir>] [--from <pi root>] [--throughline-commit <sha>] [--service <file>] [--json]");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// A check that could not run exits 3, so the Health Hub adapter tells it apart from a check that found a regression.
		process.exitCode = verb === "check" ? 3 : 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
