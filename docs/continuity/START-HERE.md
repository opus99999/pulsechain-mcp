# PulseChain Continuity — start here

Begin in SUCCESSOR_READ_ONLY. Knowledge loading does not activate a role or transfer a task.

1. Read [current.json](current.json). Resolve its checkpoint_path relative to this directory and verify the checkpoint's canonical content_sha256.
2. Read that exact checkpoint for source coverage. Its matching handbook is the same checkpoint_path with the .json extension replaced by .md. A historical handbook is never implicitly current.
3. Use [Head Chef](HEAD-CHEF.md) or [Control Center](CONTROL-CENTER.md) startup instructions. Other existing roles use their own approved contract and the per-role handover module referenced by the current instruction registry.
4. Reconcile current [issue #43](https://github.com/opus99999/pulsechain-mcp/issues/43), queues, source/deployment and receipts before consequential work.
5. Read [UPDATE.md](UPDATE.md) for the existing maintenance path. Checkpoint-only updates leave these pointer-based entry instructions stable.

Read verification times, source cutoffs, limitations and supersession from the resolved checkpoint. It is a dated, non-atomic fallback, not live worker-execution evidence. Website availability, configured schedules, run timestamps, accepted actions and delivery are separate observations. Never use an old local sandbox path as durable storage. Preserve historical checkpoints unchanged.
