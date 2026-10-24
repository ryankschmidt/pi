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

At the fork root, run `npm ci --ignore-scripts`, then `npm run build`. This lab lives under `throughline/`, outside the root's `packages/*` and `apps/*` workspace patterns, so it adds no entry to the stock root lockfile.

From this folder, run `npm ci --ignore-scripts`, then `npm run build`. The lab has its own package manifest, lockfile, and TypeScript build, which emits ignored files under `dist/`. Its `file:` dependencies link directly to the fork's `packages/durable`, `packages/ai`, and `packages/chord`, each at version 1.4.0. Their runtime dependencies come from the root install; no separate registry copy of Pi Durable is installed. To refresh this lab's dependency metadata, run `npm install --ignore-scripts` here and review only this folder's lockfile.

From this folder, run `node smoke.ts first`, then `node smoke.ts second`, starting with no `data/smoke.sqlite`. Both processes use that same database. Runtime output stays under the locally ignored `data/` folder. The second process must reopen the conversation, reuse the pending submission ID, finish the input, and retain six history entries.

`node probe-rail.ts single` exercises request-ID reuse and watch-frame serialization. For the two-process ownership probe, run `node probe-rail.ts owner` and, while it holds the database open, `node probe-rail.ts intruder`. These are observations of the vendor's behavior, not an exclusive-owner guarantee.

## Preserved measurement

The original README at `/Users/Admin/core-root/vault/01_Projects/workbench/infra/pi-harness/pi-durable-lab/README.md` records this measurement verbatim:

> Measured Oct 22, 2026, 5:15 AM PDT: the first process answered one input, reset the context with a handoff note, submitted a second input and exited before it ran; the second process reopened the same conversation, resubmitting the same request id returned the same submission (not a duplicate), finished it, and the stored history still held all six entries from before and after the reset.

The original result bytes are preserved in `evidence/first-2026-10-22.json` and `evidence/second-2026-10-22.json`. The original lab remains in place; removal belongs to the separately checked removal order.
