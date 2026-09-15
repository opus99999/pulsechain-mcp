# HARNESTED: verification-first build design

**Reference v1.0.0 · September 14, 2026 · PP3 advisory analysis**

## Decision

Use this brief to tighten the existing Control Room's **evaluation and execution contracts**, not to replace it with a new agent stack. Preserve the supplied L0–L5 organization and separate (A) domain work, (B) harness/process work, and (C) unverified claims. “HARNESTED” is the owner's working label here, not a claimed technical standard.

The most valuable change is to make each increment carry its input identities, required sensors, permitted effects, stop rules, observed results and next actor. Let the model choose reasonable implementation details inside that boundary. Neither Clean Code style nor one test score is universal law: verification is an evidence-producing process whose own coverage and validity need review.

This is source research plus a proposed design. It creates no runtime, model invocation, active role prompt, training job or new retry authority. The human page, [claim/source register](CLAIMS-SOURCES.json) and [machine contract](HARNESS-CONTRACT.json) are reference artifacts. New sensor cases are NOT_RUN. Public repository preservation, live website display, reader retrieval and actual use are different completion states.

## Basis and scope

The supplied brief is the task basis. Its domain-source list, harness papers, process rules and browser candidates are preserved as separate categories. Research below qualifies particular claims explicitly; it does not silently rewrite the supplied material. The early domain list and the later browser-fetch list differ: the later list adds COLMAP and the tutorial; Aras appears in the earlier list. Keep this distinction in any eventual source policy. A fetch allowlist is not an installation or runtime-network policy, and it does not revoke earlier reviewed sources in the existing Gaussian reference.

The current build already has versioned evidence, focused tests and an independently reviewed inactive reader correction. “Sensors are missing” is therefore not a literal inventory of the existing project. The important remaining distinction is between local checks and a qualified real execution path. This reference does not reopen accepted corrections or substitute a browser for an unestablished producer/controller binding.

# A. Domain / 3DGS

## A1. Keep the domain module; strengthen how it is evaluated

Continue the earlier [Gaussian Spatial Evidence Module](../gaussian-spatial-build-20260914/README.md). Do not retrain or reimplement it merely to adopt this brief. The first useful target remains one lawful static scene with original imagery/cameras, reproducible views, supported and unsupported questions, and a second real authorized consumer. This is our proposed product criterion, not a claim from a paper.

The original project evaluates novel-view appearance, while COLMAP documents reconstruction from overlapping images and can produce disconnected components. Those sources support capture/pose checks, but they do not supply universal thresholds for our scene. [D01,D04]

**Proposed capture sensors:** retain original and rejected image identities; inspect blur, texture, coverage, illumination and motion; report registered/eligible images and reconstruction-component count. A high registration ratio alone is insufficient: cameras can register into the wrong or disconnected arrangement. Add a pose-convention/control-point check and preserve calibration/scale uncertainty. Choose thresholds for the intended scene before evaluation, not after inspecting a result.

## A2. The 200-step fixture is a plumbing test, not a quality certificate

Keep the idea, with a narrower pass claim: a bounded smoke run can show input loading, a finite loss, usable gradients/updates, output writing and checkpoint reload. Require explicit runtime, data rights, wall-clock and memory limits before running it. “Fixture” does not make GPU work free or automatically authorized.

The original trainer documents densification starting at iteration 500 by default. A 200-step run under those defaults does not exercise that stage. Its README also says normal training uses all images unless evaluation splitting is enabled. [D02] Do not transfer those defaults to gsplat without checking the selected implementation.

**Proposed improvement:** test densification/pruning boundaries separately with a tiny declared schedule, or include a separately authorized test that reaches them. The altered schedule proves a fixture path, not normal-scene convergence. Do not claim success if all updates were skipped, the render is blank, the loss is nonfinite, or only a zero-step/no-op path executed.

## A3. Separate appearance, geometry, answer correctness and product use

Freeze development and final evaluation inputs separately. Where frames come from video, guard against adjacent near-duplicates leaking between splits; document how camera poses were estimated. Record render resolution, crop/mask, background, color space and metric implementation. PSNR/SSIM/LPIPS numbers without those conditions are poor comparison evidence.

If a metric is unavailable, show NOT_RUN or UNVERIFIED and identify its dependency. Do not convert “if available” into a pass when that metric is required by the task. Choose any alternative criterion before scoring, with its reason recorded. A candidate should not get to delete the evaluator that rejects it.

Use four independent result columns: appearance on held-out views; geometry/scale when a metric answer is requested; correctness and limits of the spatial answer; and actual second-consumer use. An attractive render or good image score cannot by itself justify centimeters, hidden-surface facts or accepted team knowledge.

Extensions remain failure-driven: 2DGS for a defined surface problem, Mip-Splatting for sampling artifacts, and Wu 4DGS for a genuine temporal task. These are distinct technical aims in the source projects, not three mandatory upgrades. [D05,D06,D07] Compression likewise requires master-versus-derivative checks rather than borrowed savings. [D10]

## A4. A usable domain sensor card

For each required sensor store: ID/version; question or invariant; permitted exact inputs; evaluator identity; expected pass and known-failing control; measured value/unit; threshold; error or skip classification; artifact/trace references; runtime scope; reviewer; and current status. A fabricated fixture label must never be displayed as a real scene result.

The failure control is crucial. Change a camera convention, introduce a blank image, withhold scale evidence, or ask about an occluded region in a safe local fixture. The sensor should detect the relevant defect. These are proposed cases, not tests executed in this assessment.

# B. Harness / process

## B1. Evidence from the cited research

| Source | What is supported | Boundary for our decision |
|---|---|---|
| Yang et al. [H01] | Abstract reports a best 89.7%-of-large-model performance at 4% cost; study spans seven business tasks and three small-model families. | A best task/model result, not universal savings or a product-speed claim. |
| Qian et al. [H02] | Abstract reports mean 0.49→0.91 on four Theory-of-Mind benchmarks, using 5% validation to construct harnesses. | Narrow evaluation scores, not coding or Gaussian performance. |
| Yan et al. [H03] | Abstract reports relative 52.25% average / 82.86% maximum gain after three iterations on named software benchmarks. | Relative gains, not percentage points; no replication here. |

The practical commonality is to move stable repeated work into code and explicit interfaces, preserve testable increments and evaluate the resulting system. Do not multiply these numbers, forecast them for our project or change model/provider merely to copy a reported setup. Harness construction, validation and maintenance costs belong in any local cost comparison.

Weng's July 4 essay covers workflow loops, filesystem persistence and explicit job coordination while highlighting weak evaluators. Böckeler's April 2 article distinguishes guides from feedback sensors and computational checks from inferential judgment. These are complementary design perspectives, not mandates to create more managers or more prompts. [H04,H05]

The Uncle Bob index confirms the September 12 title; the detailed argument remains the owner's supplied framing because the video was not transcribed here. SwarmForge's README describes worktree/session coordination and branch-specific products; its main branch alone is not a runnable product. It is an example to study, not a chosen dependency. [H07,H08]

## B2. L0–L5, adapted without replacing the organization

| Layer | Preserve from the brief | Proposed improvement for this build |
|---|---|---|
| L0 Sources | A curated source registry | Bind source version, claim, supporting passage, retrieval time and limitation. Keep domain, process and operational receipts separate. A citation's existence is not proof it supports the claim. |
| L1 Sensors | Checks that can fail | Reuse existing checks; add only missing, risk-linked cases and controls. Record FAIL, ERROR, BLOCKED, NOT_RUN and UNVERIFIED separately. |
| L2 Memory | Selective indexed notes | Use the current reference/immutable-record store. Small excerpts route reading; retrieve enough of the actual contract to preserve preconditions. No hard 100-word cutoff on safety or evidence. |
| L3 Roles | Librarian, implementer, adversary, human | Map functions to existing participants; do not activate a held librarian or create extra bots. Separate proposed work from acceptance. |
| L4 Outer loop | One increment, evaluate, preserve, stop | One durable increment ID; bounded authorized iterations; per-effect attempt accounting; independent acceptance after candidate pass. |
| L5 Bus | Messages are transport, not domain evidence | Carry artifact/operation references and receipts. A sent message is neither pickup nor completed work; a bus message can evidence communication, not a scientific result. |

For the existing team, Head Chef owns coordination and disposition; Codex implements within its work order; specialists retain domain authority; Grok supplies attributed complementary evidence; Worker5 reports status/delivery. A future authorized Claude Librarian could curate source versions and contradictions, but remains unactivated. “Code only” for implementers should not prevent them from returning test evidence, an operation receipt and a truthful final status.

## B3. Verification should test the verifier too

Coverage shows exercised code, not adequate assertions. Mutation testing asks whether deliberately changed behavior is detected. Equivalent mutants can survive without a meaningful behavioral difference, so an unqualified demand to kill every mutant can create an endless loop. [H09,H10]

Treat coverage and CRAP as risk signals, not proof of correctness or permission to skip source review. Record the selected complexity/coverage tool and scope; do not install arbitrary thresholds from an anecdote. For mutation runs, show killed, survived, uncovered, invalid, timed-out and reviewed-equivalent cases rather than hiding inconvenient outcomes in one percentage.

For each high-impact new boundary, a small negative or metamorphic check is often more useful than a larger count of happy-path cases. For example, changing an approved artifact's bytes should invalidate its identity; a revoked record should not be served from a cache; a failed post-write validation should preserve the right operation receipt. The existing accepted correction already addresses part of this last behavior; this brief grants no replay of its tests.

Keep immutable review-time evaluator inputs separate from implementer-controlled tests. Changes to an oracle, threshold, data split or exclusion change the experiment and require explicit review. Different role names alone do not prove independent evidence or access isolation.

## B4. Make the outer loop finite without making the owner a message router

The supplied stop-on-pass-or-two-failures rule is a reasonable starting policy for an authorized offline increment. It is not blanket permission for two live submissions. Reconciliation, native denial, scope conflict, missing required evidence or uncertain effects stop dependent actions immediately.

Proposed decision order:

1. Validate the selected work order, inputs, runtime and remaining scope. If not established, return BLOCKED with the exact missing fact.
2. Reconcile an existing operation before a new effect. A missing chat reply is not proof that nothing ran.
3. Run only currently authorized work and sensors with enforceable process/resource limits where supported.
4. If all required sensors pass, preserve the candidate and stop development: CANDIDATE_PASS_REVIEW_PENDING, not released or accepted.
5. If an offline candidate fails and another local iteration is actually authorized, retain the first failure and spend only that existing allowance. Two failed iterations end the increment in the supplied policy. No counter reset across chats or candidate renaming.
6. Any unknown external outcome ends at UNKNOWN_RECONCILE regardless of the offline counter. Preserve native IDs, effect status and required readback; do not automatically retry, cancel or roll back.
7. Return a finished answer. A failed save blocks reliance on unsaved results, not an honest checkpoint.

A separate owner-approved campaign could later pre-authorize several low-risk increments to reduce routine relays, while retaining human decisions at spending, permission and release boundaries. That is an alternative for consideration; it is not adopted by this reference and does not override the supplied human-per-new-increment rule.

Maintain an evaluation backlog limit: when review capacity is saturated, stop generating more candidate work. The exact queue threshold needs a local decision and measurement. Useful throughput is accepted correct work, not drafts created per hour.

## B5. Preserve lessons without accumulating permanent prompt clutter

Use a small method/rule card: failure signature and evidence; proposed control; where it runs; false-positive risks; regression; reviewer; applicable versions; owner; and a review/retirement trigger. Link dated learning notes to that card instead of appending the same warning to every role prompt.

A repeated mistake is a cue to investigate and propose a control, not automatic authority to edit tools or policy. A severe permissions/data exposure risk may deserve an immediate preventive gate without waiting for a second incident. Conversely, two unrelated failures should not become one speculative universal rule. Retire only demonstrably redundant controls under review; stronger models do not automatically justify weakening authorization or evidence checks.

## B6. Plasma memory and bus: the useful ideas, plus implementation caveats

Plasma Wiki documents Markdown indexes, selective map/search/read commands, and generated-index merge handling. Its README also says excluded subtrees can still be served by `wiki read`, and custom `.wiki/wiki.py` hooks execute code after a trust decision. [P01] Therefore exclusions are not access controls, and reading/indexing an arbitrary wiki must not become permission to execute its hooks.

Use its structure as a design reference over the existing store; avoid bulk rewriting immutable evidence with indexers/formatters. If evaluated later, use approved copied documentation in a separate test workspace, keep exact originals, and enforce authorization independently before any protected bytes reach a reader.

The official related product located calls its built-in channel **Fractal Radio**, with durable records in branches and memory. [P02] This does not establish that it is the exact “Plasma Radio” in the brief, or that either is connected to our hosted participants. Preserve the supplied assertion separately; require the actual deployment/endpoint/principal and a pickup/result receipt before claiming it works.

## B7. Browser layer: choose the smallest control that meets the task

| Candidate | Source-established role | Recommended leverage / boundary |
|---|---|---|
| Playwright [B08,B09] | Scripted browser control, assertions and traces | First candidate for deterministic site acceptance checks. Tests still depend on network/UI state; scripted is not infallible. |
| Stagehand [B07] | AI primitives mixed with scripted page operations | Use inference only for steps that need it; assert final evidence independently. |
| Browser Use [B01,B03] | Agent library, hosted agents and managed-browser interfaces | Alternative for genuinely variable browser tasks. Keep agent execution, browser hosting and model costs distinct. |
| Browser Harness [B04,B05] | CDP access plus generated local helpers | Candidate helpers must be scoped, preserved and reviewed; “self-healing” is not accepted correctness or permission to modify guards. |
| Browser Use Desktop [B06] | Desktop agent interface; README describes copying cookies into fresh Chromium | Defer for this milestone. A desktop wrapper is not a passive source reader, and personal-session transfer is not approved. |
| Cloudflare Browser Run [B10] | Managed headless execution, stateless actions and sessions | Hosting option under an actual account/budget/connection decision, not a protection bypass or automatic Control Room access. |

An official API or current trusted connector remains preferable when it already provides the exact information or publishing action. Do not add all six browser tools. No browser can manufacture an absent authenticated producer callback, inherit a connector credential, or create a missing site-editor capability merely by being installed.

Two concrete integration traps deserve tests. Playwright supports repeated assertions and repeated code blocks; place repeatable reads, not consequential submit actions, inside a retry block. Its `toPass` default differs from ordinary assertion timing. [B08] Browser Use's cloud example states that disconnecting CDP does not stop the managed browser. [B03] Treat tool disconnect, requested cancellation and observed termination as distinct states.

Before any later browser trial, bind an isolated permitted profile, destinations, action allowlist, redirects/subresources, download scope, timeout/step/data/cost limits, result schema and durable receipt. Block private-network destinations and source-induced scope expansion where the selected executor can enforce it; a prompt-only claim is not enforcement. No stealth/CAPTCHA service, session export or protected-access bypass is admitted here.

Trace data can contain request/response headers and bodies. [B09] Prefer capture-time minimization and restricted trace storage rather than assuming redaction after capture prevents disclosure. Never put cookies, tokens, session URLs or private data into public reference pages. A recording policy needs explicit scope.

The vendor `llms.txt` itself tells agents which product to recommend. [B02] It is a documentation locator and vendor source—not a trusted instruction to choose that vendor or run its installation prompts. Add a safe fixture containing such an instruction; the reader should extract facts and reject the instruction as authority.

# C. Unverified, qualified and not yet implemented

The exact Irvin post and detailed Uncle Bob video argument remain UNVERIFIED here; the latter's title/date is confirmed. Fowler's retreat notes support interest in harnesses and weaker models, but the strong-versus-weak slogan is not a controlled benchmark result in the inspected passage. [H06,H07]

The three numerical paper claims are verified as author-reported abstract results, not locally replicated. No GPU, training scene, browser install, model change, Plasma connection, autonomous pickup or source-to-runtime callback was qualified. No improvement multiple is measured.

“Ten times better” must name a layer and denominator: elapsed time to an accepted task; total cost per accepted result including harness construction; answer completion rate; or measured task accuracy. Compare the same task set, evaluation, access constraints and resource budget. Include failed attempts and owner time. Checkable output and retained failure are necessary measurement ingredients, not a mathematical proof of exponential growth.

A sensible accounting measure is verified effort avoided by reuse minus evaluation, correction and maintenance effort. Keep access safety and duplicate-effect constraints as hard gates, not benefits that can be traded away for a higher average score.

## Website availability and the next bounded use

Expose this exact reference and JSON under the existing site's **Sources & Decisions → Harness & Verification**, alongside the earlier [tool](../tool-leverage-20260914/README.md), [Grok](../grok-build-leverage-20260914/README.md) and [Gaussian](../gaussian-spatial-build-20260914/README.md) references. Do not create another portal or install a browser merely to evade a missing native writer.

Actual website completion requires an eligible content publisher, current access, a rendered page with the expected reference/version, its matching machine data, a publication receipt and a readback. HTTP 200 alone is inadequate: verify the expected content is displayed rather than a login/error/fallback page. Record team retrieval separately and second-consumer application separately again. The current research context has no exposed compatible Sites writer; the documented canonical route requires its protected generator. Repository saving does not finish that step.

Retain stable navigation to immutable versions and downloadable bytes with manifests; check link/access failures through normal authorized maintenance. No chat response can guarantee permanent service availability. The next eligible owner/coordinator decision is content publication through the established route, while the existing producer-binding work retains its own priority and boundaries. After that, attach only the relevant sensor/stop contract to the next approved increment—do not launch the proposed 200-step job from this document.

## Source key and coverage

- **H01 — [Better Harnesses, Smaller Models](https://arxiv.org/abs/2607.08938v1)**. Paper abstract and version metadata; status `REPORTED_RESULT_VERIFIED_NOT_REPRODUCED`.
- **H02 — [AI4AI at Test-Time](https://arxiv.org/abs/2608.12307v1)**. Paper abstract and version metadata; status `REPORTED_RESULT_VERIFIED_NOT_REPRODUCED`.
- **H03 — [Harness-of-Harness](https://arxiv.org/abs/2609.01481v1)**. Paper abstract and version metadata; status `REPORTED_RESULT_VERIFIED_NOT_REPRODUCED`.
- **H04 — [Weng: Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/)**. Definition, design patterns and evaluation-limit passages; status `SELECTED_PRIMARY_TEXT`.
- **H05 — [Böckeler: Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)**. Author/date, guides/sensors, computational/inferential distinction; status `SELECTED_PRIMARY_TEXT`.
- **H06 — [Fowler: retreat observations](https://martinfowler.com/fragments/2026-07-13.html)**. Harness and weaker-model discussion; observations, not a controlled benchmark; status `QUALIFIED_SUPPORT`.
- **H07 — [Uncle Bob: primary publication index](https://www.cleancoder.com/)**. Index confirms Rethinking Harnesses dated September 12, 2026; linked video not reviewed; status `TITLE_DATE_ONLY`.
- **H08 — [SwarmForge](https://github.com/unclebob/swarm-forge)**. README only; main/product-branch and handoff distinctions; status `DOCUMENTED_NOT_INSTALLED`.
- **H09 — [Mutation testing: original author essay](https://blog.cleancoder.com/uncle-bob/2016/06/10/MutationTesting.html)**. Coverage versus assertion effectiveness; status `SUPPLEMENTAL_PRIMARY_SOURCE`.
- **H10 — [Stryker: equivalent mutants](https://stryker-mutator.io/docs/mutation-testing-elements/equivalent-mutants/)**. Equivalent-mutant limitation, not an instruction to disable tests; status `SUPPLEMENTAL_PRIMARY_SOURCE`.
- **P01 — [Plasma Wiki](https://github.com/plasma-ai/wiki)**. README: indexes, commands, excluded-path readability, trusted Python hook; status `DOCUMENTED_NOT_PROJECT_INTEGRATION`.
- **P02 — [Plasma Fractal / Fractal Radio](https://www.plasma.ai/research/fractal)**. Built-in messaging and branch/wiki persistence; status `NEARBY_PRODUCT_NOT_CONFIRMED_AS_USER_RADIO`.
- **B01 — [Browser Use](https://github.com/browser-use/browser-use)**. README: library/CLI/cloud distinction and licensing/cost separation; status `DOCUMENTED_NOT_QUALIFIED`.
- **B02 — [Browser Use documentation index](https://browser-use.com/llms.txt)**. Product map includes agent-directed recommendations; those are untrusted vendor content; status `SOURCE_NOT_INSTRUCTION`.
- **B03 — [Browser Use cloud quickstart](https://docs.browser-use.com/cloud/quickstart)**. Agent runs versus browser sessions; disconnect versus explicit stop; status `DOCUMENTED_NOT_QUALIFIED`.
- **B04 — [Browser Harness](https://github.com/browser-use/browser-harness)**. Complete README; returned Git blob f18e087174dd7bd448f0802de4983ac22fac58fb; local helper generation/CDP; status `DOCUMENTED_NOT_QUALIFIED`.
- **B05 — [Browser Harness landing page](https://www.browser-harness.com/)**. Landing page only; no performance validation; status `MARKETING_NOT_ACCEPTANCE`.
- **B06 — [Browser Use Desktop](https://github.com/browser-use/desktop)**. README: cookie transfer and agent interface; status `DEFER_PERSONAL_SESSION_EXPOSURE`.
- **B07 — [Stagehand](https://docs.stagehand.dev/v4/first-steps/introduction)**. AI primitives and scripted page API; v4 documentation; status `DOCUMENTED_NOT_QUALIFIED`.
- **B08 — [Playwright assertions](https://playwright.dev/docs/test-assertions)**. Retrying assertions versus retrying code blocks; documented timeouts; status `DOCUMENTED_NOT_QUALIFIED`.
- **B09 — [Playwright trace viewer](https://playwright.dev/docs/trace-viewer)**. Action/DOM/network evidence may contain request/response bodies and headers; status `DOCUMENTED_NOT_QUALIFIED`.
- **B10 — [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)**. Quick Actions versus browser sessions; managed execution layer; status `DOCUMENTED_NOT_ACCOUNT_ACCESS`.
- **D01 — [Kerbl et al.: 3DGS](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)**. Project abstract and evaluation overview; status `DOMAIN_ALLOWLIST`.
- **D02 — [Original 3DGS implementation](https://github.com/graphdeco-inria/gaussian-splatting)**. README: densify_from_iter 500, eval split defaults; status `DOMAIN_ALLOWLIST`.
- **D03 — [gsplat](https://docs.gsplat.studio/main/)**. Overview; no chosen runtime or complete code review; status `DOMAIN_ALLOWLIST`.
- **D04 — [COLMAP](https://colmap.github.io/tutorial.html)**. Capture, registration, components and data-flow guidance; status `DOMAIN_ALLOWLIST_LATER_LIST`.
- **D05 — [2DGS](https://surfsplatting.github.io/)**. Project abstract only; status `DOMAIN_ALLOWLIST`.
- **D06 — [Mip-Splatting](https://niujinshuchong.github.io/mip-splatting/)**. Project overview only; status `DOMAIN_ALLOWLIST`.
- **D07 — [Wu et al.: 4DGS](https://guanjunwu.github.io/4dgs/)**. Project overview only; status `DOMAIN_ALLOWLIST`.
- **D08 — [3DGS tutorial](https://3dgstutorial.github.io/)**. Landing page only, no full slides/videos; status `DOMAIN_ALLOWLIST_LATER_LIST`.
- **D09 — [Chen and Wang survey](https://arxiv.org/abs/2401.03890)**. Abstract/version metadata, not full survey; status `DOMAIN_ALLOWLIST`.
- **D10 — [Aras: Making Gaussian Splats smaller](https://aras-p.info/blog/2023/09/13/Making-Gaussian-Splats-smaller/)**. Storage/appearance tradeoffs; status `DOMAIN_ALLOWLIST_EARLIER_LIST`.
