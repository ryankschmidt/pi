---
title: "Pi Durable fork lab"
description: "Credential-free recovery and rail probes using the fork's Pi Durable 1.4.0 workspace siblings."
type: reference
status: active
created: "2026-10-24"
last_updated: "2026-10-24"
---

# Pi Durable fork lab

This package copies the existing Mac lab into the Pi fork namespace. Its smoke and rail probes use the free in-memory faux model, with automatic compaction disabled. Nothing in ThroughLine, the Pi launcher, or the installed extensions loads this lab.

## Run

The root's existing `packages/*` workspace pattern includes this package. Its three exact 1.4.0 dependencies use the sibling `durable`, `ai`, and `chord` workspaces, not separate registry installations. Verify the links with `npm query .workspace`.

The prescribed `npm ci --ignore-scripts` currently refuses because the stock root lockfile does not contain this new workspace. The lockfile is deliberately unchanged: updating it would violate this order's zero-upstream-edit boundary without a separate advance approval. Local hydration uses `npm install --ignore-scripts --package-lock=false`; this is not a passing clean-install check. After hydration, run `npm run build`. The work-order receipt records the actual install, build, and test results.

From this folder, run `node smoke.ts first`, then `node smoke.ts second`, starting with no `data/smoke.sqlite`. Both processes use that same database. Runtime output stays under the locally ignored `data/` folder. The second process must reopen the conversation, reuse the pending submission ID, finish the input, and retain six history entries.

`node probe-rail.ts single` exercises request-ID reuse and watch-frame serialization. For the two-process ownership probe, run `node probe-rail.ts owner` and, while it holds the database open, `node probe-rail.ts intruder`. These are observations of the vendor's behavior, not an exclusive-owner guarantee.

## Preserved measurement

The original README at `/Users/Admin/core-root/vault/01_Projects/workbench/infra/pi-harness/pi-durable-lab/README.md` records this measurement verbatim:

> Measured Oct 22, 2026, 5:15 AM PDT: the first process answered one input, reset the context with a handoff note, submitted a second input and exited before it ran; the second process reopened the same conversation, resubmitting the same request id returned the same submission (not a duplicate), finished it, and the stored history still held all six entries from before and after the reset.

The original result bytes are preserved in `evidence/first-2026-10-22.json` and `evidence/second-2026-10-22.json`. The original lab remains in place; removal belongs to the separately checked removal order.
