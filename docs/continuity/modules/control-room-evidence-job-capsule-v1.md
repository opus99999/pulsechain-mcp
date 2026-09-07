# Control Room Evidence Job Capsule — architecture decision v1.0.0

> Implementation continuation, September 7, 2026: the owner authorized the single-capsule extension and selected the existing private GitHub repository. [Verified extension release v1.0.0 and private setup handoff](../reviews/gaussian-capsule-extension-v1.md) records Sites v55, exact protected staging, and launch held. The design below retains its original baseline restrictions; those are not a claim that the authorized extension is still absent. Pinned original: commit `344fb9a5523f1ffdbd31b71ae20eee54ae3e43aa`.

Status: **IMPLEMENTATION-READY DESIGN; NOT DEPLOYED OR ACTIVATED**  
Created: 2026-09-07T18:02:24.488Z  
Maintainer: incumbent ChatGPT Head Chef performing the existing Control Center implementation function  
Scope: one connected increment; no new organization, account, task, schedule, database/event schema, service, provider activation, model run, deployment, purchase, API billing, or identity transfer.

## Decision

Use the deployed Work Hub secure enrollment/run/artifact/update contracts to carry an **Evidence Job Capsule**: one hash-bound package connecting one authorized producer, one explicitly invoked executor, and one named consumer.

A capsule is not a wake signal, chat message, new lifecycle event, or general memory. Existing feeds and queues detect work; Head Chef judges it; a provider-specific activator must separately prove invocation; Work Hub persists scoped inputs, outputs, and audit evidence; the named consumer must prove retrieval and use.

The first intended capsule is **Gaussian L1 Knowledge-Integrity Review**. It reuses the existing Gaussian v0.1.0 candidate/evaluator packages and asks Claude Opus 5—only after an already-entitled execution context is verified and separately authorized—to check source linkage, manifest integrity, scoring consistency, evidence separation, contradictions, and reproducibility. It does not run a Gaussian model, answer the benchmark, alter the selection, or rewrite accepted findings. Until the Claude gate passes, state is **STORED_NOT_INVOKED**.

## Baseline

The Gaussian evaluator package contains answers, poses, scoring material, and source annotations that must not be pasted into ordinary prompts or public summaries. Manual chat forwarding loses durable access scope and does not prove use.

Live readback at 2026-09-07T18:02:24.488Z found Site version 54 at source commit `2de29303298c7fe12b3ab9c80cb5b34630e891a4`. The deployed database already contains task enrollments, scoped authorities, secure runs, artifacts, upload/download grants, final updates, atomic finalization, dependencies, and chained audit events. It has 12 historical enrollments—all canaries—of which 8 completed and 4 stale attempts were deactivated; 8 secure runs and 8 secure artifacts completed, also all canaries. Ordinary Work Hub run, artifact, and access-grant tables are empty.

Canary scopes show 8 MiB direct and 48 MiB multipart upload bounds. Audit readback includes scoped session issuance, run start, server hash verification, single-use download consumption, and atomic completion. This proves the storage/receipt substrate under segregated canary conditions. It does not prove a current non-canary enrollment, a provider wake, or cross-provider use.

## Connected actor/tool/data path

1. **Detect:** existing coordination queues, Grok observation review, quality review, and artifact manifests identify new or due work. Discovery advances its own index without creating an executable job. Failed reads remain coverage gaps.
2. **Judge:** Head Chef selects the minimum actor, objective, cutoff, artifact set, authority, disclosure class, and completion test. Only this judgment may authorize a non-canary enrollment.
3. **Activate:** a provider-specific adapter invokes the approved execution surface and returns a receipt. A queue row, MCP endpoint, public page, schedule, or last-run timestamp is not an invocation receipt.
4. **Execute:** the executor claims the exact enrollment, verifies and downloads only granted artifacts, performs only allowed operations, uploads hash-bound results, and finalizes once.
5. **Consume:** the named consumer retrieves the exact result and creates its own existing update or governed record citing source update/artifact IDs and the action taken. Publication alone is not consumption.

Worker #5 remains the owner interface. Workers #1–#4 retain specialist authority. Grok Head Chef remains coordinator of existing Grok bots. Claude is Knowledge Integrity and Evaluation support only.

## Artifact and identity contract

Carry a versioned JSON manifest as an existing Work Hub artifact; do not add a production schema for v1. Required fields are:

- `capsule_schema: "pulsechain-evidence-job-capsule@1.0.0"`, capsule ID, creation time, objective, source cutoff;
- producer worker/workstream, authority, and source record IDs;
- executor provider, exact expected context, role, model policy, and allowed operations;
- named consumer and required use record;
- each artifact's role, filename, bytes, SHA-256, media type, visibility, source version, and generation time;
- accepted/provisional/synthetic classifications, unavailable evidence, and prohibited inferences;
- tool/configuration digest, input/output byte limits, wall-time ceiling, attempt count, and zero financial allowance;
- success tests, failure tests, and recovery.

The manifest hashes every carried file; a detached checksum hashes the final manifest. It has no unexplained self-hash.

The provider invocation receipt must contain provider, exact context/run/session ID, requested and observed actor/model, capsule ID and manifest hash, invocation time, completion/stop state, usage source, and tool-scope digest. Invocation states are distinct: `NO_INVOCATION_ATTEMPTED`, `INVOCATION_CONFIRMED`, and `ATTEMPTED_OUTCOME_UNKNOWN`. An absent receipt after an attempted launch is not proof that no run occurred; reconcile exact provider and Work Hub state before any permitted retry. This corrects the original v1.0.0 wording without altering the pinned historical bytes.

## First Gaussian capsule

Reuse the [Gaussian scope](./gaussian-l1-scope-v1.md) and [verified construction result](https://github.com/opus99999/pulsechain-mcp/issues/43#issuecomment-5573913911):

- candidate ZIP: 5,931 bytes, SHA-256 `b07e0a124a748a8c3cd3c7e308816a2b8aacbe033968d8aa296d78d9103cdf4e`;
- owner/evaluator ZIP: 4,615,537 bytes, SHA-256 `ac71b2f9e3a2528a91b681bbf0048f5b57c5ba062583e599f9e4eba30ba8658f`;
- internal manifest: SHA-256 `9d89cf4f19e57d256eaba3859a2d548065169c97909d92463250ca06a190bf41`;
- scientific state: 3 selected SQA3D scene IDs, 18 source-backed questions, 14 unfilled challenge slots, 0 scene/view assets, 0 model runs.

The evaluator ZIP fits the observed direct-upload limit. V1 caps each artifact and total input at 8 MiB; multipart is excluded. Candidate-facing execution must not receive evaluator material.

Claude may only verify hashes/source versions, identify contradictions in readiness/scoring/access records, test reproducibility instructions without inference, and return pass/fail/unknown with sources. Outputs: `knowledge-integrity-review.json`, `knowledge-integrity-review.md`, detached checksums, and exact provider/Work Hub receipts.

The first consumer is ChatGPT Head Chef. Consumption means reading the complete result, checking hashes, and recording a bounded disposition against `gaussian-l1-scope-v1.md`.

## Provider boundaries

| Provider | Supported path and evidence | Persistence / usage source | Exact missing operation |
|---|---|---|---|
| ChatGPT | Existing Head Chef scheduled task executes its protected prompt; native readback shows it enabled and an ordinary September 7 run. | Task state persists in ChatGPT; project evidence persists in GitHub/Site records. Existing subscription/task capability supplies usage. | No exposed operation lets a Work Hub row wake or inject work into another preserved Worker conversation. A scheduled Head Chef run may pull a capsule; it cannot claim to activate Workers #1–#5. |
| Grok | Existing Grok Bot box agent/Grok Head Chef is the execution context. Shared-box signing authenticates only provisional `grok-x-protocol` posting. Observation 50 and signed receipts prove transport; the assisted operations canary proves an approval-assisted round trip, not unattended activation. | Existing provider runtime/subscription and shared browser state. Authorization is shared-box scope, not exclusive-bot credential isolation. | No callable control here delivers a capsule to agent `098a040d-daa5-4c65-973c-e903d892d324` and returns a provider invocation receipt. Posting and operations ledgers are not activators. |
| Claude | Anthropic documents Opus 5, explicit model selection, noninteractive `claude -p`, and Claude Code GitHub Actions. The repository's example Claude Desktop MCP config is configuration text, not invocation evidence. | Must use an already-entitled subscription/seat or existing authorized GitHub integration. Account entitlement, host, model readback, persistence, and usage accounting are unverified. | No owner-authorized Claude surface with model/account/status readback and least-privilege Work Hub artifact I/O is connected. No Claude run, secret, app, or API billing is authorized here. |

Primary references: [ChatGPT scheduled tasks](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt), [Claude model configuration](https://docs.anthropic.com/en/docs/claude-code/model-config), [Claude headless execution](https://docs.anthropic.com/en/docs/claude-code/headless), [Claude Code GitHub Actions](https://docs.anthropic.com/en/docs/claude-code/github-actions), and [Claude model overview](https://docs.anthropic.com/en/docs/about-claude/models/overview).

## Implementation sequence

1. Revalidate version-54 secure enrollment/run/artifact/update/finalization endpoints and pin recovery source.
2. Add an offline capsule validator and Gaussian manifest instance; test detached hashes, duplicate IDs, visibility separation, missing fields, sizes, and source identities.
3. Define one least-privilege non-canary enrollment template for `knowledge-integrity-evaluation`; do not issue it before executor identity and activator approval.
4. Select and verify one existing Claude surface. Read back account/seat, Opus 5 availability, host/repository scope, tools, persistence, and usage source.
5. Add the smallest adapter: claim one enrollment; download two scoped inputs; upload two result files/checksums; finalize or abort. It may not publish findings, edit the repository, activate another actor, or exceed the capsule.
6. Run one bounded real capsule only after separate activation authority. Head Chef verifies and consumes the result.
7. Promote only if the intended consumer used the result with zero manual artifact relay and preserved evidence boundaries. Otherwise disable the adapter and preserve the audit trail.

## Acceptance, failure, limits, and recovery

Success requires exact stored hashes; evaluator isolation; one provider receipt proving the selected Claude context and observed Opus 5 model; one non-canary Work Hub run finalizing once; Head Chef retrieval and a substantive use record; zero manual artifact relay; and no changes to worker authority, accepted findings, tasks, schedules, keys, or financial state.

Stop on actor/model mismatch, missing invocation receipt, hash/type/size mismatch, evaluator leakage, broader tool scope, duplicate claim/finalization, silent rewriting, or unapproved paid/API usage. An unavailable executor leaves the capsule prepared and disabled.

One normal attempt is allowed. One retry requires the immutable capsule, no accepted invocation/finalization, exact no-commit readback, unchanged hashes/scope, and an open provider gate. Ambiguity retains the last confirmed state. Hash/access failure quarantines only that enrollment/adapter and preserves history. Rollback disables the adapter and pending template; Site v54, canaries, posting, schedules, Gaussian files, and accepted records remain unchanged.

V1 limits: one capsule, one executor, one consumer; 8 MiB per artifact and total input; static validation only; no GPU, inference, training, crawl, package installation, production deployment, financial action, purchase, or new billing.

## Owner decision before execution

Select and authorize one **already-entitled Claude surface**: either an owner-controlled Claude Code headless host or a repository-scoped Claude Code GitHub Action, with exact least-privilege Work Hub artifact scope. If neither exists, keep the Claude lane disabled. This design does not authorize provisioning or purchase.

## Current independent work

PHIAT remains at accepted sequence 28. Signals / `signals-platform` is the next actor and must originate the corrected `SPECIALIST_PUBLICATION_ACCEPTED` event while preserving sequence-28 decision, dependencies, and summary exactly. Head Chef does not originate it. This increment does not delay Worker #5's owner delivery.
