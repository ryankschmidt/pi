---
title: "ThroughLine Pi Durable provider — source under implementation"
description: "Mac execution-store ownership and admission/outcome recovery code; not an installed or accepted ThroughLine integration."
type: README
status: draft
created: "2026-10-29"
last_updated: "2026-11-04"
---

# ThroughLine Pi Durable provider

**Source only. Do not point ThroughLine at this folder.** It has no executable entry point, production model/tool resource profile, authenticated Tower adapter implementation, or installed runtime contract. No existing thread, history, provider setting, database authentication, or running service was changed to enable it.

This code belongs to the Pi fork namespace and uses its existing Pi Durable 1.5.0 workspace libraries (1.4.0 until the Nov 4, 2026 upstream fold). `store.ts` owns an exclusive private SQLite store, persists its agent/thread/conversation binding, and exposes the verified immutable target. A launcher must retain the worker's PID and its own nonce before launch and serialize dead-owner reclamation. `admission.ts` requires a matching Tower admission receipt before native submission, binds stable operation IDs to payload hashes, and persists pending outcomes separately from acknowledged shared outcomes. A completed native response is not independent work acceptance.

The record boundary in `record.ts` accepts typed admission and outcome operations only. It does not accept database options, credential material, arbitrary SQL, or a local shared-record fallback. Its interface still requires the authenticated server-owned implementation.

## Proof limits

The tests use the real fork's Durable Harness and SQLite, but a faux model and explicitly fake Tower record. The recovery test kills only the subprocess it captured, reclaims its exact ownership proof after exit, reopens the same conversation, preserves history, and recovers an idempotent file effect under the same tool-task identity. These are source-level recovery tests, not a supported ThroughLine consumption test, a live Tower outage test, or production acceptance.

The independent source review is preserved under the parent Pi harness task evidence at `_meta/mac-first-durable-2026-10-29/source-review/report.raw.txt`. Its confirmed findings were addressed in source; those revisions have not received a second independent review. A source review is not the required non-builder, screenshot-backed cold consumption.

## Necessary integration boundaries

The bounded Tower-side read-only adapter preflight returned PostgreSQL authorization code `28000`; it did not read or return credentials or change authentication. Existing SSH access is therefore not sufficient database authority for that experiment. The current native Pi prompt frames also omit the stable application operation/message identifiers required by the integration contract. A binary-path-only switch is not a safe activation mechanism.

Still required: the authenticated server-owned Tower adapter and native Absurd lifecycle/event wiring; the opt-in ThroughLine provider mount with stable identities; the selected instruction/tool/approval profile; streaming and stop translation; real-work consumption and fault tests through that supported path; independent cold acceptance with screenshots; and governed installation/rollback. The Linux factory and socket rollout are not prerequisites for this work.

## Focused checks

From this directory, `node --test test/*.test.ts` runs only these tests. `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` checks this source and its tests against the fork's installed library declarations. Neither command establishes an installed integration.
