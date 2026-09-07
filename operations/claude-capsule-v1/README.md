# Claude Gaussian capsule — prepared connection v1.0.0

**PREPARED; NOT INVOKED; NOT LAUNCH-READY.** Maintainer: ChatGPT Head Chef acting as the existing Control Center implementation function. Verified September 7, 2026. Parent decision: [Evidence Job Capsule v1.0.0](https://github.com/opus99999/pulsechain-mcp/blob/344fb9a5523f1ffdbd31b71ae20eee54ae3e43aa/docs/continuity/modules/control-room-evidence-job-capsule-v1.md).

The repository route is selected. The target is the existing **private** `opus99999/pulsechain-research-control-room-bridge` repository (ID `1345447956`); public `pulsechain-mcp` carries only preparation code and nonsecret records. The workflow is stored outside `.github/workflows` and has no active trigger. Nothing in this package invokes Claude, enrolls an actor, uploads evaluator material, installs software, creates a secret, or changes a schedule.

## What is ready

- `capsule.json` binds the exact existing Gaussian v0.1.0 ZIPs, desired `claude-opus-5`, role, consumer, immutable input version and finite limits.
- `adapter.py` verifies archives without extraction/execution and exposes only an allowlisted, bounded read interface over their exact members. It includes provider-message model checks, invocation-state distinction and strict conditional retry evaluation. No broad Bash/Read/WebFetch/repository-write tools are provided.
- `workflow.prepared.yml` is valid, explicit-dispatch-only preparation. It has a 20-minute limit, concurrency one, first-attempt guard, contents-read and OIDC-only permissions. Its preflight rejects the current incompatible Work Hub. Live orchestration is deliberately not wired.
- `result.schema.json` and `review-instructions.md` define the bounded private review output. `test_adapter.py` uses synthetic software fixtures only. Real input checks are in `validation-results.json`.

## Exact readiness findings

No Claude workflow was found in the full current public or private repository trees. The latest ten public Actions runs contain existing project workflows, not Claude; this bounded history is not an all-time non-invocation proof. No matching capsule enrollment was found in complete native enrollment readback or the shared maintenance record. No invocation was attempted by this preparation.

The connector cannot read installed GitHub App configuration, secret names, Claude account status, or private billing/quota metadata. These are **UNAVAILABLE**, not proven absent. Local access to the two ZIPs is verified; cross-provider retrieval is not.

The deployed Work Hub does not yet support this ordinary reviewer identity, capsule-only private input scope, or pre-enrollment of an unpredictable review result. Details and the narrow required extension are in [WORK_HUB_COMPATIBILITY.md](./WORK_HUB_COMPATIBILITY.md). The next owner approval is that bounded extension; a new Claude credential alone cannot resolve these technical gates.

## Private Claude setup — only after the transport gate is resolved

Anthropic's [GitHub Actions documentation](https://code.claude.com/docs/en/github-actions) supports subscription OAuth from eligible Pro, Max, Team or Enterprise accounts using `claude setup-token` and the `CLAUDE_CODE_OAUTH_TOKEN` secret. An `ANTHROPIC_API_KEY` is a separate API billing route and is excluded. Account entitlement, Opus 5 access and remaining included allowance must be verified in the owner's existing Claude account. An OAuth token is not a budget lock; do not proceed if extra usage could be charged or included usage cannot be established.

The eventual owner operation is: in the existing Claude Code session signed into the intended subscription, verify account/model/usage and run `claude setup-token`; save the resulting value directly in the existing private repository's [Actions secrets settings](https://github.com/opus99999/pulsechain-research-control-room-bridge/settings/secrets/actions) as `CLAUDE_CODE_OAUTH_TOKEN`. Never paste it into chat, a repository file, issue, command log or output artifact. Retain only nonsecret setup confirmation. If an authorized existing secret works, reuse it. Secret creation/private authorization requires the owner's action; it was not performed here.

That subscription token is not inherently restricted to one repository, one model or one capsule. GitHub secret storage limits where a workflow can retrieve it; trusted workflow code and runtime isolation enforce this job's use. If the owner requires a provider-issued per-job token, no such control was verified. Do not call this credential project-administration access or pretend it is a narrow per-job provider permission.

The official [action source](https://github.com/anthropics/claude-code-action/blob/9c5ddab2e6d17b83ea679153b31f1d5f023cf636/src/github/token.ts) accepts an explicitly supplied GitHub token. Its default app exchange asks for contents/issues/PR write access. The published app permission list additionally includes Actions, checks, discussions, hooks and workflows writes plus member/metadata/status reads. Selecting one repository does not narrow each of those capabilities. This job does not need that app: a reviewed direct Claude Code invocation under GitHub Actions can use checkout's read token and a separate OIDC request for Work Hub. No app installation is requested here.

The official action's [pinned action.yml](https://github.com/anthropics/claude-code-action/blob/9c5ddab2e6d17b83ea679153b31f1d5f023cf636/action.yml) installs dependencies. Under the current no-installation constraint, use only a verified existing runtime on the selected runner; none was established. This preparation does not download a binary, use a new self-hosted runner, or silently broaden installation authority. The generated CLI arguments require version 2.1.259 or newer for restricted mode and unattended denial. The model is explicitly `claude-opus-5`; actual model must match provider init, assistant-message and final modelUsage fields. [Model configuration](https://code.claude.com/docs/en/model-config), [CLI reference](https://code.claude.com/docs/en/cli-reference).

GitHub Actions is separate usage: [standard public runners are free, while private runs consume the account's included allowance](https://docs.github.com/en/billing/concepts/product-billing/github-actions). This job stays private and requires at least the 20-minute ceiling within the existing allowance and no charged overage. Quota is unverified here. Do not move sensitive execution into a public repository to evade this check. No artifact/cache upload or larger runner is configured.

## Runtime contract to wire only after readiness

The trusted orchestrator retrieves two protected artifacts through server grants and verifies both size/hash pairs before making them available to the reviewer. It passes no GitHub/OIDC/Work Hub credential to Claude or its tool server. Only the subscription OAuth credential reaches the Claude process. The tool server receives only the verified in-memory inputs. Run in a restricted ephemeral workspace with outside files inaccessible; the provider transport alone needs approved Anthropic egress. CLI restrictions supplement, and do not prove, OS/network isolation. The runner's actual isolation must be verified before launch.

Execute no packaged code for the first review: expose it as text. The existing validator has a mode that rewrites validation/manifest files; therefore it cannot be assumed read-only by filename. Any later executable check requires prior inspection and an isolated copy, with no network or installation and no changes to the frozen packages.

Before any dispatch or provider-launch call, persist one immutable attempt intent with capsule/file hashes, exact workflow SHA, model, job scope and attempt number. After GitHub dispatch, a matching GitHub run establishes workflow invocation only. Claude invocation requires structured provider session/model evidence. Once a launch was attempted, timeout/missing receipt means `ATTEMPTED_OUTCOME_UNKNOWN`; reconcile run/session/Work Hub readback before the one permitted conditional transport retry. No automatic model rerun is allowed.

Enforce limits in the orchestrator before launch: 600 seconds review, 12 turns, 8 MiB input ZIPs combined, 32 MiB total expanded members, 32 KiB per read, 512 KiB total tool input, 2 MiB captured provider stream and 256 KiB final review. Stop/terminate on model mismatch immediately when surfaced, byte/time/turn exhaustion or approval/capacity failure. A fallback may already have performed some generation when detected; quarantine its output and do not accept it as Opus 5. Capture full output only to the protected own-output area; logs contain opaque IDs/status/hash/counts only. Never upload a transcript to GitHub Actions artifacts or comments.

Finalize only after server hash verification and exact receipt readback. Head Chef must retrieve and assess the complete private result and write its own concise issue43 disposition. Publishing this preparation, a successful preflight, a provider receipt alone or an acknowledgment does not meet that success test. A justified no-change finding is acceptable. No human should relay runtime ZIPs between chats; any such relay must be recorded honestly.

## Offline reproduction

Run `python3 -m unittest discover -s operations/claude-capsule-v1 -p 'test_*.py'` from the preparation checkout. To verify the already-held inputs, run `python3 operations/claude-capsule-v1/adapter.py inspect --inputs /approved/local/input-directory`. This prints only input hashes/counts. `preflight` exits 78 by design. No software fixture counts as a real Claude result or a Gaussian question.

Preserve the existing passwordless Grok path, observer feed review, roles and schedules. PHIAT remains owned by Signals pending its corrected publication-acceptance event. This capsule does not block it.
