// Claude Code's standard system prompt, first, for Pi Durable agents on Claude models (Pi's own Anthropic provider,
// api anthropic-messages). This file is its one home: the capture from the pinned Claude Code, the cache and the section.
// Ryan, Nov 3, 2026: "Of course, the standard Claude prompt is non-negotiable."
// Pi Durable reports and skips a section that throws and sends the request anyway (packages/durable/src/harness/
// prompt.ts), so a section cannot stop a request. The prompt is therefore resolved before the program serves anything
// (claudeStandardPromptAtStart, called by main.ts), and the section only returns text it already holds.
// The stock Pi extension (workbench tools/pi-claude-standard-prompt, installed as ~/.pi/agent/extensions/
// claude-standard-prompt.js) is a frozen temporary copy that reads the same cache record; TQ-1019 retires it.
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export interface StandardPrompt {
  claude_bin: string;
  claude_version: string;
  text: string;
  sha256: string;
  first_line: string;
  captured_at: string;
}

/** The prompt resolved at start, as a ready section, or the refusal that keeps the program from starting. */
export type StartedPrompt =
  | { ok: true; extension: Extension; claude_version: string; sha256: string }
  | { ok: false; refusal: string };

export const CLAUDE_STANDARD_PROMPT_EXTENSION = "claude-standard-prompt";
export const CLAUDE_STANDARD_PROMPT_UNAVAILABLE = "CLAUDE_STANDARD_PROMPT_UNAVAILABLE";
/** The capture's temporary Claude Code config folder starts with this; a prompt naming it would point at a deleted folder. */
export const CAPTURE_DIR_PREFIX = "pi-claude-standard-prompt-";
/** Cache folder, file names and record shape are shared with the frozen stock copy, so both send the same bytes. */
export const STATE_DIR = path.join(os.homedir(), ".local/state/pi-claude-standard-prompt");

/** Resolves the prompt once, before any turn, and returns the section; refuses when no usable prompt can be had. */
export async function claudeStandardPromptAtStart(
  apiOf: (provider: string, modelId: string) => string | undefined,
): Promise<StartedPrompt> {
  let prompt: StandardPrompt;
  try {
    // loadStandardPrompt returns only usable text: cached records and fresh captures both pass unusableReason.
    prompt = await loadStandardPrompt();
  } catch (error) {
    return { ok: false, refusal: refusal(error instanceof Error ? error.message : String(error)) };
  }
  return {
    ok: true,
    extension: createClaudeStandardPromptExtension(prompt.text, (provider, modelId) => apiOf(provider, modelId) === "anthropic-messages"),
    claude_version: prompt.claude_version,
    sha256: prompt.sha256,
  };
}

// The refusal says why the check exists. Every model is refused, not only Claude: ThroughLine can switch a running
// thread to a Claude model, and a prompt loaded later would be a section that can fail, which Durable skips.
function refusal(reason: string): string {
  return (
    `${CLAUDE_STANDARD_PROMPT_UNAVAILABLE}: ${reason}. ` +
    "The agent program did not start. Claude Code's standard prompt is non-negotiable for Claude models, and Pi Durable " +
    "sends a request without any section that fails, so starting now would send Claude turns without it. " +
    `The prompt is captured once per pinned Claude Code into ${STATE_DIR}; fix the cause named above and start again.`
  );
}

/** The section: the resolved text for models `takesPrompt` accepts, nothing otherwise. It holds no state. */
export function createClaudeStandardPromptExtension(
  text: string,
  takesPrompt: (provider: string, modelId: string) => boolean,
): Extension {
  return defineExtension({
    name: CLAUDE_STANDARD_PROMPT_EXTENSION,
    sections: [
      section(
        "claude_standard",
        (input) => {
          const model = input.agent.model;
          return model !== undefined && takesPrompt(model.provider, model.modelId) ? text : undefined;
        },
        { tag: false },
      ),
    ],
  });
}

/** Cached per pinned binary: the standard prompt changes only when the Claude Code pin moves. Any unusable record is recaptured. */
export async function loadStandardPrompt(claudeBin = pinnedClaude(), stateDir = STATE_DIR): Promise<StandardPrompt> {
  const version = pinnedClaudeVersion(claudeBin);
  const cachePath = path.join(stateDir, `standard-prompt-${version.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
  const hit = cachedPrompt(cachePath, claudeBin);
  if (hit !== undefined) return hit;
  const text = await capture(claudeBin);
  const record: StandardPrompt = {
    claude_bin: claudeBin,
    claude_version: version,
    text,
    sha256: sha256(text),
    first_line: text.split("\n")[0] ?? "",
    captured_at: new Date().toISOString(),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  // Written whole, then renamed into place: several agents start at once after a pin move, and none may read half a record.
  const temporary = path.join(stateDir, `.${path.basename(cachePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(record, null, 1) + "\n");
  fs.renameSync(temporary, cachePath);
  return record;
}

/** Version comes from the pinned versions entry, whether it is the executable or a directory containing it. */
function pinnedClaudeVersion(binary: string): string {
  const parts = path.resolve(binary).split(path.sep);
  const index = parts.lastIndexOf("versions");
  const version = index >= 0 ? parts[index + 1] : undefined;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Claude executable is not in a versioned versions/<version> path: ${binary}`);
  }
  return version;
}

/** Resolve the real pinned Claude binary from FCCL when present, otherwise the calling server's PATH. */
export function pinnedClaude(
  configPath = path.join(os.homedir(), ".local/state/ryan/fccl/static-shim-config.json"),
  searchPath = process.env.PATH,
): string {
  let configured = true;
  try { fs.lstatSync(configPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    configured = false;
  }
  if (configured) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { real_targets?: { claude?: unknown } } | null;
    const claude = config?.real_targets?.claude;
    if (typeof claude !== "string" || !path.isAbsolute(claude)) throw new Error(`${configPath} names no absolute real_targets.claude`);
    if (!fs.statSync(claude).isFile()) throw new Error(`${claude} is not a Claude executable file`);
    fs.accessSync(claude, fs.constants.X_OK);
    pinnedClaudeVersion(claude);
    return claude;
  }
  if (!searchPath) throw new Error("Claude executable cannot be resolved: PATH is empty or missing");
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(dir || ".", "claude");
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch { continue; }
    const binary = fs.realpathSync(candidate);
    pinnedClaudeVersion(binary);
    return binary;
  }
  throw new Error("Claude executable was not found as an executable on PATH");
}

// A missing, torn, other-binary, altered or unusable record is a miss, never a refusal: the capture replaces it.
function cachedPrompt(cachePath: string, claudeBin: string): StandardPrompt | undefined {
  let record: Partial<StandardPrompt> | null;
  try {
    record = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<StandardPrompt> | null;
  } catch {
    return undefined;
  }
  const text = record?.text;
  if (record?.claude_bin !== claudeBin || typeof text !== "string" || sha256(text) !== record?.sha256) return undefined;
  return unusableReason(text) === undefined ? (record as StandardPrompt) : undefined;
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Why a prompt text must not be sent, or undefined when it may: applied to fresh captures and cached records alike. */
function unusableReason(text: string): string | undefined {
  if (text.length < 1000) return `it is ${text.length} characters; Claude Code's full prompt is longer than 1,000`;
  if (text.includes(CAPTURE_DIR_PREFIX)) {
    return `it names Claude Code's temporary capture folder (${CAPTURE_DIR_PREFIX}...), which is deleted right after the capture`;
  }
  return undefined;
}

interface SystemBlock {
  type?: string;
  text: string;
}

/**
 * Claude Code sends [billing header, identity line, standard prompt]. Pi's own Anthropic provider sends
 * its own identity line, so only the standard prompt itself is kept. The trailing token-budget line is
 * Claude Code's own session state, not instructions.
 */
export function standardPromptFromBlocks(blocks: ReadonlyArray<SystemBlock>): string {
  const kept = blocks
    .map((block) => block.text)
    .filter((text) => !text.startsWith("x-anthropic-billing-header:"))
    .filter((text) => !(text.length < 200 && /^You are (Claude Code|a Claude agent)\b/.test(text)));
  const joined = kept.join("\n\n").replace(/\n*<total_tokens>[^<]*<\/total_tokens>\s*$/, "").trim();
  const problem = unusableReason(joined);
  if (problem !== undefined) throw new Error(`the captured standard prompt is unusable: ${problem}`);
  return joined;
}

/** Runs the pinned Claude Code once against a loopback server and returns the standard prompt from its first request. */
export function capture(claudeBin: string, model = "claude-opus-5-5", timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), CAPTURE_DIR_PREFIX));
    let settled = false;
    let child: childProcess.ChildProcess | undefined;
    const finish = (error: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      child?.kill("SIGTERM");
      server.close();
      fs.rmSync(configDir, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(text!);
    };
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.url?.startsWith("/v1/messages") && !request.url.includes("count_tokens")) {
          try {
            const parsed = JSON.parse(body) as { system?: string | SystemBlock[]; tools?: unknown[] };
            const blocks = typeof parsed.system === "string" ? [{ text: parsed.system }] : (parsed.system ?? []);
            if (blocks.some((block) => block.text.length > 1000)) finish(null, standardPromptFromBlocks(blocks));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt capture only" } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      child = childProcess.spawn(claudeBin, ["-p", "--model", model, "--setting-sources", "", "--max-turns", "1", "Reply with OK."], {
        cwd: os.homedir(),
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: os.homedir(),
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: "prompt-capture-placeholder",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          // Pi Durable has no Claude Code auto memory; without this the prompt tells every agent to keep memory in
          // configDir, deleted above. Documented at https://code.claude.com/docs/en/memory.
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
      });
      child.on("error", (error) => finish(error));
      child.on("exit", () => setTimeout(() => finish(new Error(`${claudeBin} exited before sending a model request`)), 500));
    });
    setTimeout(() => finish(new Error(`no model request from ${claudeBin} within ${timeoutMs} ms`)), timeoutMs).unref();
  });
}
