# Continuity maintenance V1

Approval: owner DURABLE CONTINUITY HUB AND ROLE-SUCCESSION READINESS V1, recorded in [issue #43](https://github.com/opus99999/pulsechain-mcp/issues/43#issuecomment-5552340615). Responsible actor: the existing Head Chef, performing Control Center implementation only with actual supported tools. This document is an approved project maintenance procedure; it does not grant a new role or expand permissions.

## Existing review path

The existing Head Chef review reads `/api/v1/continuity`, current primary queues and issue #43. Check source coverage, instruction versions/hashes, task bindings, deployment and open operations. Preserve role-specific private knowledge; a summary never substitutes for an unavailable primary artifact. If nothing material changed, make no continuity write and do not create a snapshot merely to refresh a date. Public API reads perform no writes.

## Material change

1. Read the publication repository's `docs/continuity/current.json` and referenced immutable checkpoint. Validate canonical SHA-256, approval and publisher provenance. Reconcile conflicts with current task readback, primary receipts and deployed state.
2. Before a consequential mutation, append one public-safe intent to existing issue #43: operation ID, incumbent execution owner, exact scope, source/prestate, last confirmed step, provider IDs, receipt/commit certainty and mandatory readback before retry. Preserve restricted details only in protected Sites source or existing protected artifacts. A URL with an obscure name is not protection.
3. Perform authorized work, then verify provider readback. An ambiguous write remains `RESULT_UNCERTAIN`, never completed or retry-safe. Record the exact missing check. Preserve immutable sources; do not create a replacement operation after uncertainty.
4. Prepare the smallest public-safe checkpoint update. Keep `document_version` for the contract; use a fresh `checkpoint_id`, `previous_checkpoint_id` and per-source times. Do not advance `last_verified_at` for an unavailable source. Distinguish configured schedule, run timestamp, queue read, accepted action, deployed change, verified behavior and owner delivery.
5. Run `node --import tsx scripts/continuity-record.mjs INPUT_JSON OUTPUT_DIR PREVIOUS_JSON` in the protected application source checkout. It rejects invalid/public-private/conflicting instruction data, preserves immutable checkpoint bytes, deduplicates timestamp-only snapshots and generates matching Markdown plus a current pointer. Review prose for private data; automated field/secret checks are not a substitute for that review.
6. Use supported GitHub project tools to commit only the generated `docs/continuity/` files to `opus99999/pulsechain-mcp`. Read the latest main parent first. Preserve old checkpoints. No force push: reconcile a concurrent main change before updating. This is a documentation checkpoint, not a specialist publication or Head Chef lifecycle event.
7. Read the exact committed JSON, pointer and Markdown back, compare canonical content hash and source cutoff, and append the verified result to issue #43. Retain provider-returned commit/comment/deployment IDs. A GitHub maintenance comment readback is not a canonical lifecycle receipt.

The website reads that versioned repository pointer and also derives current public-safe operational metadata from existing accepted projections. It labels repository failures, dated fallback, live-read failures, stale records and conflicts. No deployment is needed for a checkpoint-only update. Changes to application behavior still require the normal tested Sites release.

## Instruction registry

Preserve exact task prompt bytes in the owner-authenticated application source under `continuity-restricted/`; never import them into client code or copy them into public assets/fallback. Publish only approved scope, approval/publisher references, hash, version, effective/superseded dates and actual saved comparison. `APPROVED`, `SAVED_CONFIGURATION_VERIFIED`, `PROPOSED_NOT_INSTALLED`, `SUPERSEDED` and `UNAVAILABLE` are distinct. Never reconstruct a missing raw prompt from a summary and call it exact. A proposed prompt does not replace saved authority.

## Completion and activation

Record `UPDATE_MECHANISM_INSTALLED` separately from `UPDATE_MECHANISM_OBSERVED`. A foreground checkpoint publication demonstrates that path once; it does not prove a scheduled updater ran. Both successor startup prompts remain `SUCCESSOR_READ_ONLY`. Actual new conversation identity, exclusive writer ownership, reconciliation and supported task binding require a future owner-approved transfer. No task transfer, replacement conversation, new recurring task, Grok replacement or financial action is part of this procedure.
