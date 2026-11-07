---
type: README
name: "Pi Durable agent program"
purpose: "One Node.js process per agent store: takes the store's lock, runs Pi Durable's Harness on SQLite, and serves Pi Durable calls as JSON lines over stdin and stdout. Build 1 of map v3."
status: active
created: "2026-11-04"
last_updated: "2026-11-06"
---

# Pi Durable agent program

Build 1 of the Pi Durable build map v3 (`/Users/Admin/core-root/vault/01_Projects/workbench/infra/pi-harness/_meta/durable-main-engine-2026-11-04/Durable-Engine-Build-Map-v3.html`). ThroughLine does not use it yet; build 2 adds the Durable client in the ThroughLine fork.

## What it does

1. Takes `owner.lock` in the store folder. A second program on the same store is refused with `STORE_ALREADY_OWNED`; a lock left by a killed program is taken over by the next start.
2. Opens Pi Durable's Harness on `store.sqlite`, with the coding agent's model runtime, settings, skills, project context files and system prompt sections as libraries (`src/setup.ts`), and Durable's own read, write, edit and bash tools.
3. Copies into `transcript.jsonl` anything stored but not yet written there, then appends every stored entry and every new conversation as Durable publishes its commits (`src/transcript.ts`). One file per agent, append-only, all branches; Durable never reads it.
4. Installs the same extensions every start, resumes what the last process left, and says `hello` with the protocol version, engine, Durable version, store, agent and pid.
5. Serves calls (`src/protocol.ts`): submit, wait, abort, compact, fork, watch, unwatch, entries, abortTask, status, drain. Closing stdin stops it, as with Pi's RPC mode.
6. ThroughLine's tools: ThroughLine hands over its tool list as a JSON file (`--tools`); each becomes a Durable tool named `throughline__<tool>`. A call leaves as a `tool` message on stdout and its answer comes back as a `toolResult` on stdin; ThroughLine's server makes the MCP call for the thread that owns the pipe. The agent holds no MCP client, endpoint or credential (protocol 2, Nov 6, 2026).

## Run

```bash
node src/main.ts --store <store folder> --agent <agent id> --cwd <working folder> [--model provider/model] [--tools <tool list file>]
```

Models, logins and settings come from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).

## Checks

```bash
node --test test/*.test.ts                      # 5 tests over a scripted fake model
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
PI_CODING_AGENT_DIR=<agent dir> node proof/kill-proof.ts <run folder> <evidence folder>   # real model
node proof/decide.ts <evidence folder> '<JEV answers>' <request id> <results sha256>
```

The built `packages/coding-agent/dist` must match the 1.5.0 source (`npm run build:unbundled` in that package).

## Not yet

ThroughLine's approvals and prompt, Ryan's Pi extensions, image tool, and APPEND_SYSTEM.md are build 3. The Oct 29 draft in `../durable-provider/` is left as it was.
