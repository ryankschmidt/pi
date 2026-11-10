---
type: README
name: "Pi Durable agent program"
purpose: "One Node.js process per agent store: takes the store's lock, runs Pi Durable's Harness on SQLite, and serves Pi Durable calls as JSON lines over stdin and stdout. Build 1 of map v3."
status: active
created: "2026-11-04"
last_updated: "2026-11-09"
---

# Pi Durable agent program

Build 1 of the Pi Durable build map v3 (`/Users/Admin/core-root/vault/01_Projects/workbench/infra/pi-harness/_meta/durable-main-engine-2026-11-04/Durable-Engine-Build-Map-v3.html`). ThroughLine does not use it yet; build 2 adds the Durable client in the ThroughLine fork.

## What it does

1. Takes `owner.lock` in the store folder. A second program on the same store is refused with `STORE_ALREADY_OWNED`; a lock left by a killed program is taken over by the next start.
2. Opens Pi Durable's Harness on `store.sqlite`, with the coding agent's model runtime, settings, skills and project context files through its public package entry only (`src/setup.ts`), and Durable's own read, write, edit and bash tools. The system prompt is the program's own: it describes this program and Durable's tools, and adds pi's global `APPEND_SYSTEM.md` as its `addendum`. HTTP setup is `src/http.ts`. Without `--model`, it starts on pi's default provider and model, or with no model until ThroughLine configures one.
3. Copies into `transcript.jsonl` anything stored but not yet written there, then appends every stored entry and every new conversation as Durable publishes its commits (`src/transcript.ts`). One file per agent, append-only, all branches; Durable never reads it.
4. Installs the same extensions every start, resumes what the last process left, and says `hello` with the protocol version, engine, Durable version, store, agent and pid.
5. Serves calls (`src/protocol.ts`): submit, wait, abort, compact, fork, watch, unwatch, entries, abortTask, status, drain. Closing stdin stops it, as with Pi's RPC mode.
6. ThroughLine's tools: ThroughLine hands over its tool list as a JSON file (`--tools`); each becomes a Durable tool named `throughline__<tool>`. A call leaves as a `tool` message on stdout and its answer comes back as a `toolResult` on stdin; ThroughLine's server makes the MCP call for the thread that owns the pipe. The agent holds no MCP client, endpoint or credential (protocol 2, Nov 6, 2026).
7. Skill commands are ordinary text (`src/setup.ts`, `skills` section): the user's message is stored exactly as typed. The prompt lists command-only skills (`disable-model-invocation: true`, such as show-me) under `<available_commands>` with one rule: for `/<name>` or `/skill:<name>`, read that file with read first and follow it, the rest of the message standing in for `$ARGUMENTS`. The skill body is then a stored tool result of the run, replayed unchanged after a restart or fork. The installer pins Ship Warden's shipped show-me at `capabilities/skills/show-me/SKILL.md`; it wins over any same-named skill in pi's default, project or configured skills. The transcript writer records a binding line naming the live conversation at every start, fork and rewind, and the prompt names the transcript so show-me reads only the live branch.
8. Image tools (`src/image-tools.ts`): `generate_image`, `edit_image` and `inspect_image` from the subscription-images module the installer pins at `capabilities/subscription-images/`; `inspect_image` passes approvals as read-only. The copy must provide exactly those three tools, each with a schema that passes a whole-tree check and pi's schema compiler; the installer runs that check on the copied files. When it is absent, fails to load or exports another contract, the agent starts without them and says why on stderr; the installer refuses such a copy before it switches an install in.
9. Carrying a stock Pi thread (`--carry-from <session file>`, `src/carry.ts`): every entry of the stock session file is written into the store in one commit, messages as Durable entries with their original messages (images whole), context edits as Durable context edits, and system prompt snapshots, model changes and custom records as data-only entries. `carried-from.json` beside the store names the source file and its sha256. A re-carry appends only the entries after the last one carried. Nothing is cut.

## Run

```bash
node src/main.ts --store <store folder> --agent <agent id> --cwd <working folder> [--model provider/model] [--tools <tool list file>]
```

Models, logins and settings come from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).

## Checks

```bash
node --test test/*.test.ts                      # 15 tests; test/agent.test.ts runs src/main.ts against a local model endpoint
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
PI_CODING_AGENT_DIR=<agent dir> node proof/kill-proof.ts <run folder> <evidence folder>   # real model
node proof/decide.ts <evidence folder> '<JEV answers>' <request id> <results sha256>
```

The built `packages/coding-agent/dist` must match the 1.5.0 source (`npm run build:unbundled` in that package). The installer refuses when the shipped subscription-images module is missing, and `check` reports when a newer one shipped than the install pinned.

## Not yet

boundary-gate and pi-lead-boundary do not run on Durable: no automatic compaction and no handoffs (a Durable conversation is forked at a turn). Their stock Pi wrappers stay for stock Pi threads until the stock path retires (proposed Dec 9, 2026). The Oct 29 draft in `../durable-provider/` is left as it was.
