# Exact launch blockers against deployed Work Hub @2

Checked September 7, 2026, 2:28 p.m. EDT. Source: deployed Sites v54, commit `2de29303298c7fe12b3ab9c80cb5b34630e891a4`. This is an implementation compatibility finding, not a replacement architecture.

| Boundary | Actual implementation | Consequence for this job |
|---|---|---|
| Ordinary identity | `config/work-hub-workstreams.json` and `WORKSTREAMS` in `lib/work-hub-secure-v2.ts` admit the four specialists. Coordination is system-only. Native readback has four inactive specialist bindings and one inactive root control binding. | No Claude reviewer identity can be enrolled through the deployed ordinary path. Do not relabel Claude as Signals/Identity or activate all specialist authorities. |
| Invocation event | Bindings require `event_name=issues`, exact existing workflow/reusable-workflow refs, commits, hashes, repository ID and owner ID. | This explicit `workflow_dispatch` requires its own exact job binding. Repository membership alone is insufficient. |
| Input access | `issueSecureDownloadGrant` permits same-workstream artifacts, plus selected WORKSPACE grants; PRIVATE artifacts deny another workstream. Grants name workstreams, not a two-artifact capsule. | A PRIVATE file is not automatically reviewer-only. The adapter's local allowlist is narrower but cannot be represented as server enforcement. |
| Review output | `issueSecureSession` binds `canonical_payload_hash` before work. `completeSecureRun` hashes the complete final Markdown and artifact manifest, and rejects a different value with `TASK_ENROLLMENT_PAYLOAD_MISMATCH`. | The final text and output hashes do not exist before Claude reviews. A capsule-input hash cannot substitute for the required completion hash. |
| Read-only session | The special read-only path in `POST /api/v2/work-hub/sessions` is conditional on the existing canary plane/cycle. | It is not ordinary-review authorization. Do not use it for this job. |
| Inputs | Exact readback: 12 historical canary enrollments; 8 secure artifacts, neither input hash present; ordinary artifacts table empty. | The local package ZIPs are verified, but there are no ordinary protected Work Hub artifact IDs for runtime retrieval. |
| Consumer | Head Chef is not a current ordinary Work Hub execution authority. | Head Chef's receipt and complete private-result retrieval also need an explicit supported grant. A public review summary is not sufficient. |

## Existing paths to preserve

The following are actual routes, not invented APIs: `POST /api/v2/work-hub/sessions`; `POST /api/v2/work-hub/runs/start`; `POST /api/v2/work-hub/artifacts/{id}/download-grants`; `GET /api/v2/work-hub/artifacts/{id}/download`; `POST /api/v2/work-hub/artifacts/init`; `PUT /api/v2/work-hub/artifacts/{id}/upload`; `POST /api/v2/work-hub/runs/{id}/complete`; `GET /api/v2/work-hub/updates/{id}`; and run heartbeat/abort paths. Ordinary transport uses sealed short-lived sessions, content hashes, request nonces, lease nonces and exact finalization. No live calls were made to these write paths.

## Smallest additional authorization needed

Permit an additive **single-capsule ordinary reviewer contract extension** in the existing Work Hub: exact GitHub OIDC workflow/job binding; read grants limited to the two frozen input hashes/IDs; a private output reservation limited to this capsule; immutable commitment to the result once it exists; and Head Chef-only result consumption. Keep the four specialist scopes, historical canaries, root control and existing finalization validation unchanged. No wildcard completion hashes, public evaluator visibility, generic administration, or project-wide artifact access.

This exceeds merely enrolling through the existing contracts: the current source does not express it. It needs a concrete source patch, negative tests, native approval where applicable, and exact deployed readback before activation. This preparation does **not** deploy that extension or pretend the dormant write plane is operational. Do not create Claude secrets solely to unblock a job that still cannot transport its inputs/results safely.

Required acceptance tests for that follow-up: deny another artifact ID with the same filename; deny another capsule/run/consumer; deny all four specialist identities and all canary endpoints to Claude; deny arbitrary requested scopes; bind private outputs and finalization once their hashes exist without altering enrollment history; reconcile lost finalization replies; prove Head Chef can read the exact private result while an ordinary worker/public reader cannot. Bind the final workflow bytes and SHA after publication, never a placeholder hash.
