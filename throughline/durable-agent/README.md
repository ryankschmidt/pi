---
type: README
name: "Pi Durable agent program"
purpose: "One Node.js process per agent store: takes the store's lock, runs Pi Durable's Harness on SQLite, and serves Pi Durable calls as JSON lines over stdin and stdout."
status: active
created: "2026-11-04"
last_updated: "2026-11-18"
---

# Pi Durable agent program

ThroughLine's Pi Provider starts this program through the governed Pi launcher. The original build map is `/Users/Admin/core-root/vault/01_Projects/workbench/infra/pi-harness/_meta/durable-main-engine-2026-11-04/Durable-Engine-Build-Map-v3.html`; current behavior is in the source and the direction file beside that map.

## What it does

1. Takes `owner.lock` in the store folder. A second program on the same store is refused with `STORE_ALREADY_OWNED`; a lock left by a killed program is taken over by the next start.
2. Opens Pi Durable's Harness on `store.sqlite`, with the coding agent's model runtime, settings, skills and project context files through its public package entry only (`src/setup.ts`), and Durable's own read, write, edit and bash tools. The system prompt is the program's own: it describes this program and Durable's tools, and adds pi's global `APPEND_SYSTEM.md` as its `addendum`. HTTP setup is `src/http.ts`. Without `--model`, it starts on pi's default provider and model, or with no model until ThroughLine configures one.
3. The store is the only record of the conversation. The running owner serves bounded pages from the live conversation over its private read socket (`src/owner-read.ts`); show-me reads from that owner rather than a snapshot file. A rewind abandons an in-flight read, and a restarted program refuses reads until ThroughLine names the conversation again.
4. Installs the same extensions every start, resumes what the last process left, and says `hello` with the protocol version, engine, Durable version, store, agent and pid.
5. Serves calls (`src/protocol.ts`): submit, wait, abort, compact, fork, watch, unwatch, entries, abortTask, status, drain, answer, configure. Closing stdin stops it, as with Pi's RPC mode, and so does the first SIGTERM or SIGINT: either is a Durable close, so a tool call waiting on an approval goes back to pending without counting a restart. The approvals hook stores the decision in the tool task's memo `throughline.approval` before `answer` replies `matched`, so a resumed call that was decided never asks again, and one that was not asks again under the same key (its tool call id).
6. ThroughLine's tools: ThroughLine sends its tool list in `configure` (`params.tools`); the program stores it with the session (document `throughline.tools`) when it changed and installs it, and a restarted program installs the stored list before it resumes, so a call left waiting resolves its tool again. Each becomes a Durable tool named `throughline__<tool>`. A call leaves as a `tool` message on stdout and its answer comes back as a `toolResult` on stdin; ThroughLine's server makes the MCP call for the thread that owns the pipe. The agent holds no MCP client, endpoint or credential (protocol 2, Nov 6, 2026).
7. Skill commands are ordinary text (`src/setup.ts`, `skills` section): the user's message is stored exactly as typed. The prompt lists command-only skills (`disable-model-invocation: true`, such as show-me) under `<available_commands>` with one rule: for `/<name>` or `/skill:<name>`, read that file with read first and follow it, the rest of the message standing in for `$ARGUMENTS`. The skill body is then a stored tool result of the run, replayed unchanged after a restart or fork. The installer pins Ship Warden's shipped show-me at `capabilities/skills/show-me/SKILL.md`; it wins over any same-named skill in pi's default, project or configured skills.
8. Image tools (`src/image-tools.ts`): `generate_image`, `edit_image` and `inspect_image` from the subscription-images module the installer pins at `capabilities/subscription-images/`; `inspect_image` passes approvals as read-only. The copy must provide exactly those three tools, each with an object schema that pi's schema compiler accepts; the installer runs that check on the copied files and then runs the module's own shipped `check-image-schemas.mjs` (JSON Schema draft 2020-12, Ajv strict, bundled in that file) on the copied files before switching; the agent itself carries no validator. The installer also refuses a show-me whose frontmatter does not declare `pi-durable-transcript: owner-2`. When an image module is absent, fails to load or exports another contract, the agent starts without its image tools and says why on stderr; the installer refuses such a copy before it switches an install in.
9. Carrying a stock Pi thread (`--carry-from <session file>`, `src/carry.ts`): every entry of the stock session file is written into the store in one commit, messages as Durable entries with their original messages (images whole), context edits as Durable context edits, and system prompt snapshots, model changes and custom records as data-only entries. `carried-from.json` beside the store names the source file and its sha256. A re-carry appends only the entries after the last one carried. Nothing is cut.

## Run

```bash
node src/main.ts --store <store folder> --agent <agent id> --cwd <working folder> [--model provider/model]
```

Models, logins and settings come from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).

## Checks

```bash
node --test test/*.test.ts                      # test/agent.test.ts runs src/main.ts against a local model endpoint
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
PI_CODING_AGENT_DIR=<agent dir> node proof/kill-proof.ts <run folder> <evidence folder>   # real model
node proof/decide.ts <evidence folder> '<JEV answers>' <request id> <results sha256>
```

The built packages must match the folded source and validated release model data. The installer refuses when the shipped subscription-images module is missing, and `check` reports when a newer one shipped than the install pinned.

### Build trap: generated model-data timestamp can hide cached Codex models

On Nov 18, 2026, the ordinary online build regenerated Pi AI model data with a timestamp newer than the saved `openai-codex` catalog. Pi 1.5.2 then ignored that cached overlay even though the overlay contained GPT-6.2 Sol and Astra and the freshly generated built-in Codex catalog did not. The staged agent could not resolve GPT-6.2 Sol. This was a build-data regression, not evidence that the model or its login was unavailable.

For this fold, the fix was to preserve the regenerated data, obtain the exact public `@earendil-works/pi-ai@1.5.2` release package with lifecycle scripts disabled, validate its `dist/providers/data` against the folded source, use those release data as the generated input, and build offline. The release data's earlier timestamp allowed the newer cached catalog to load; a fresh staged program then answered on both required models. The package integrity, manifest hashes, backup path and proof are in `/Users/Admin/core-root/vault/01_Projects/workbench/skills/provider-version-pin/_meta/rewrite-2026-11-18/staged-proof/Build-Input-Provenance.json` and `Pi-Fold-Staged-Receipt.json` beside it.

For a future fold, verify the exact release package and its data against that fold's source, preserve any existing generated data before replacing it, run the offline build and the model-data validator, then check the staged program's actual model catalog and required model turns. Do not edit the manifest timestamp, silently change a user's model settings, or assume the older release package always fits a different source revision. An ordinary online build can recreate this mismatch; stop before promotion if a required model disappears.

## Not yet

boundary-gate and pi-lead-boundary do not run on Durable; `/handoff` is available as a stopgap until Live Ledger runs on every Durable session, as recorded in the Pi Durable direction file. Automatic compaction is on since Nov 11, 2026 with Pi Durable's own defaults (`src/setup.ts`, `compaction: { enabled: true }`; Ryan: "It can be on now."): a summary is written in the background from 49,152 tokens below the model's window, the run waits for one at 16,384 below, and the last 20,000 tokens are kept word for word. The summary is Pi Durable's own, written by the model; the Live Ledger specification replaces its text (`/Users/Admin/core-root/vault/01_Projects/workbench/tools/live-ledger/plans/Live-Ledger-Specification-2026-11-11.html`). The boundary add-ons' stock Pi wrappers stay for stock Pi threads until the stock path retires (proposed Dec 9, 2026). The Oct 29 draft in `../durable-provider/` is left as it was.
