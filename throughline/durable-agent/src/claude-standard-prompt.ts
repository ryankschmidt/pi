// Claude Code's standard system prompt first, for Claude models on Pi's own Anthropic provider: the Durable form of
// the pi-claude-standard-prompt coding-agent extension (workbench/tools/pi-claude-standard-prompt).
// Ryan, Nov 3, 2026: "Of course, the standard Claude prompt is non-negotiable."
// The capture and cache below are that extension's own code, unchanged, and share its cache folder, so both forms
// send the same bytes. Here it is the first section, rendered before every other section. If it cannot be read, the
// section throws and the request is not sent.
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const SHIM_CONFIG = "/Users/Admin/.local/state/ryan/fccl/static-shim-config.sh";
export const STATE_DIR = path.join(os.homedir(), ".local/state/pi-claude-standard-prompt");

export interface StandardPrompt {
  claude_bin: string;
  claude_version: string;
  text: string;
  sha256: string;
  first_line: string;
  captured_at: string;
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** The pinned Claude Code is the binary the governed `claude` launcher runs. */
export function pinnedClaude(configPath = SHIM_CONFIG): string {
  const text = fs.readFileSync(configPath, "utf8");
  const match = text.match(/^RYAN_FCCL_REAL_CLAUDE='([^']+)'/m);
  if (!match) throw new Error(`${configPath} names no RYAN_FCCL_REAL_CLAUDE`);
  return match[1]!;
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
  if (joined.length < 1000) throw new Error(`captured standard prompt is ${joined.length} characters; expected Claude Code's full prompt`);
  return joined;
}

export function capture(claudeBin: string, model = "claude-opus-5-5", timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-standard-prompt-"));
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
        },
      });
      child.on("error", (error) => finish(error));
      child.on("exit", () => setTimeout(() => finish(new Error(`${claudeBin} exited before sending a model request`)), 500));
    });
    setTimeout(() => finish(new Error(`no model request from ${claudeBin} within ${timeoutMs} ms`)), timeoutMs).unref();
  });
}

/** Cached per pinned binary: the standard prompt changes only when the Claude Code pin moves. */
export async function loadStandardPrompt(claudeBin = pinnedClaude(), stateDir = STATE_DIR): Promise<StandardPrompt> {
  const version = path.basename(claudeBin);
  const cachePath = path.join(stateDir, `standard-prompt-${version.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as StandardPrompt;
    if (cached.claude_bin === claudeBin && sha256(cached.text) === cached.sha256) return cached;
  }
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
  fs.writeFileSync(cachePath, JSON.stringify(record, null, 1) + "\n");
  return record;
}

export function composeSystemPrompt(standard: string, piPrompt: string): string {
  if (piPrompt.startsWith(standard)) return piPrompt;
  return `${standard}\n\n${piPrompt}`;
}

export const CLAUDE_STANDARD_PROMPT_EXTENSION = "claude-standard-prompt";

function record(line: Record<string, unknown>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, "applied.jsonl"), JSON.stringify({ at: new Date().toISOString(), form: "durable", ...line }) + "\n");
}

/** The section. `apiOf` tells a model's API from its reference; only `anthropic-messages` gets the standard prompt. */
export function createClaudeStandardPromptExtension(
  apiOf: (provider: string, modelId: string) => string | undefined,
  load: () => Promise<StandardPrompt> = () => loadStandardPrompt(),
): Extension {
  let standard: Promise<StandardPrompt> | undefined;
  let recorded: string | undefined;
  return defineExtension({
    name: CLAUDE_STANDARD_PROMPT_EXTENSION,
    sections: [
      section(
        "claude_standard",
        async (input) => {
          const model = input.agent.model;
          if (model === undefined || apiOf(model.provider, model.modelId) !== "anthropic-messages") return undefined;
          try {
            standard ??= load();
            const prompt = await standard;
            const key = `${model.provider}/${model.modelId}:${prompt.sha256}`;
            if (recorded !== key) {
              recorded = key;
              record({ model: `${model.provider}/${model.modelId}`, claude_version: prompt.claude_version, standard_sha256: prompt.sha256, standard_first_line: prompt.first_line });
            }
            return prompt.text;
          } catch (error) {
            standard = undefined;
            const message = `Claude Code's standard prompt could not be read, so this Claude turn was stopped instead of being sent without it: ${error instanceof Error ? error.message : String(error)}`;
            record({ model: `${model.provider}/${model.modelId}`, refused: message });
            throw new Error(message);
          }
        },
        { tag: false },
      ),
    ],
  });
}
