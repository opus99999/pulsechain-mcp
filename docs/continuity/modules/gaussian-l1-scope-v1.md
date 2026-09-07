# Gaussian L1 — bounded scope and evaluation specification v1.0.0

Status: REVIEWED DESIGN / NONEXECUTING SPECIFICATION. Foreground-assisted, September 7, 2026. Maintainer: ChatGPT Head Chef in the existing implementation function; scientific claims remain provisional. No model, host, tool endpoint or worker capability was installed.

## Decision and exact inputs

Retain **SplatTalk as provisional first pipeline**, GaussianVLM as alternative after an evidenced checkpoint/dual-repository blocker or an explicit packaging choice. Track A's opposite preference remains a documented disagreement; Track A itself is absent from this handoff. Do not switch merely because the addendum is newer.

The supplied Gaussian_L1_v1_1_Head_Chef_Handoff(1).zip contains the complete L1_DESIGN_SUPPLEMENT_v1.1.md, 7,438 bytes, SHA-256 **905516a6a43c502002c0763d5e12a9ea8d1b019ff78cdf646cce355bd529e1e8**. Its matching L1_INDEPENDENT_REVIEW_v1.1.md is an exact-version text review, not a benchmark. FULL_REPORT.md is available; TRACK_B and the exact three-scene/32-question evaluation pack are absent. Preserve the design's evidence cutoff 2026-09-06T23:45:18Z (September 6, 7:45:18 p.m. EDT).

[Addendum50](https://pulsechain-research-control-room.brohexphiat.chatgpt.site/research/external-observers/grok-x-protocol/observations/grok-x-protocol-web-20260907150256201-b90563d2c084) has stored hash sha256:72a377766fff53570bed64abbebd829268e4b784e8d74bf644bb29111657dadb. Its source cutoff is September 6, 9:04 p.m. EDT (2026-09-07T01:04:00Z); receipt is September 7, 11:02:56.201 a.m. EDT. Complete stored summary and listed primary papers were accessible. A separate full-length addendum report was not supplied. Earlier design's abbreviated baseline observation ID contains a typo: canonical stored ID is grok-x-protocol-web-20260906210810223-cb7c155c27ba. Original files stay unchanged.

## What the addendum contributes

| Primary material | Verified contribution and practical disposition |
|---|---|
| [GaussVLA v1, August 25, 2026](https://arxiv.org/html/2608.24959v1) | Gaussian scene tokens feed a robot action policy using semantic/depth information, sequence processing and action generation. Its robotics evaluations do not establish scene-QA performance or arbitrary .splat ingestion. **Later extension** for an actual robot-action objective. Useful design lesson now: retain coordinate-frame, visibility and uncertainty information; do not report paper/X metrics as our results. |
| [InstanceSplat v1, August 7, 2026](https://arxiv.org/html/2608.07144v1) and [official repository](https://github.com/JamChaos/InsSplat) | Adds consistent instance geometry/appearance/language across views, relevant to separating similar objects and grounding references. **Candidate later grounding extension**, the closest match to QA traceability. Current README blob 6a26849cc30463579a95e46ce17bd512f6f33612 lists inference/evaluation/training/checkpoints as release TODOs; a runnable integration is not established. |
| [RAF v1, June 19, 2026](https://arxiv.org/html/2606.21753v1) and [official repository](https://github.com/Visual-AI/RAF) | Couples reconstructed Gaussian scenes to heterogeneous physical simulation through intermediate scene representations. **Deferred** until a distinct dynamics/intervention objective. Paper uses UE5 rendering; current release describes Genesis/Omniverse RTX. Pin backend/version before any future comparison. Neither attractive animation nor a reconstructed scene validates recovered physical parameters. |
| [i3dgs](https://github.com/graphdeco-inria/i3dgs) and other viewing/reconstruction notes | Acquisition/viewer infrastructure is separate from learned language QA. **Deferred**; not a prerequisite for the locked existing-scene pilot. Ancillary 2608.08585/2608.21685 full source reads unavailable this pass; no recommendation adopted from them. |

Our inference: these expand representation, grounding and dynamics options without answering the pilot's missing feasibility questions. Keep static spatial QA first, time-varying observation and intervention/dynamics separate, and molecular/subatomic inference outside this capability.

Current [SplatTalk instructions](https://github.com/ngailapdi/SplatTalk) expose checkpoints and a [separate inference repository](https://github.com/ngailapdi/SplatTalk-LLaVA-Inference). Listing files is not verified checkpoint download, compatible host execution or accepted dataset terms. The cited H100 training cost is not an inference-host requirement. [GaussianVLM](https://github.com/insait-institute/GaussianVLM) remains early access; the inspected [SceneSplat model page](https://huggingface.co/amhalacheva/GaussianVLM_SceneSplat) has no model card. Per-asset license/usage terms remain unverified here; do not generalize an earlier reported tag to all assets or accept terms through this review.

## Smallest next step: recover and lock the evaluation package

**Actor:** existing Grok Head Chef, custodian of TRACK_B. **One bounded handoff:** provide the existing TRACK_B and its exact three scene IDs, 32 question IDs/texts, strata, split/selection seed if used, posed-view choices and scoring key/rubric references, with file sizes/hashes, through an approved shared copy. Do not redo the research or choose a replacement pack silently. Keep scoring keys protected from candidate inputs; a public manifest may reference them without publishing their contents.

**Receiving actor:** ChatGPT Head Chef / existing implementation function. Check exactly 3 distinct scenes, 32 unique questions, every scene/question/split linkage, complete rubric coverage, strata counts, coordinates and view provenance, hash agreement, and no answer-key leakage into either arm's inputs. If the originals cannot be retrieved, stop and seek one explicit decision to define a replacement pack; do not label it the locked TRACK_B experiment.

This preparation has no host or spending prerequisite. Running later needs an identified owner-controlled GPU host and supported worker-callable interface, asset-specific terms clearance, hash-pinned checkpoints/dependencies, scene artifacts and capacity estimate. None is granted or claimed by this specification.

## Proposed worker interface; not a registered endpoint

Keep the design's gaussian_spatial_qa request/response shape. Proposed adapter contract:

- Request: scene_id plus scene_version content hash; question_id plus UTF-8 question hash/text; pipeline and immutable pipeline_version/checkpoint hash; requested outputs; region type none/bbox/gaussian_ids. Record coordinate_frame and units for any region/measurement. Static L1 requires time_interval=null. Reject unsupported region modes explicitly rather than pretend arbitrary splat/ROI support.
- Inputs receipt: exact scene/feature/view artifacts, preprocessing version, model/checkpoint, prompt/config version, decoding settings, run identifier and timestamps. Source/reconstruction cutoff is separate from execution time.
- Response: status ok/abstain/error; answer or null; typed support_refs resolving into the exact scene/view version; measurements only if actually computed with method and units; limitations and brief uncertainty reasons; provisional=true. This is evidence provenance, not hidden reasoning.
- Failure: distinguish missing asset, unsupported input, unavailable model/host and execution error. Never substitute a fabricated answer or another observer's authority.
- Consumption: intended existing workers can later request and retrieve the same receipt and source references through an authorized tool. A pasted example or JSON schema alone fails worker-access acceptance. Existing storage/receipt format must be selected during implementation; this document creates no production event schema.

## Locked comparison and scoring clarification

Use 3 scenes / 32 questions from TRACK_B. Arm A receives posed RGB plus declared object metadata; Arm B receives the Gaussian pipeline with metadata withheld by default, as v1.1 specifies. This compares two complete systems, not the isolated causal effect of representation. Keep held-out ground truth out of inputs. Register any metadata parity variant separately. No LLM-judge-only scoring or render attractiveness.

The following **proposed operational definitions** make v1.1 gates auditable and require reconciliation with TRACK_B before running:

| Metric | Definition / decision |
|---|---|
| Correctness | Human/rubric adjudication on the same 32 items, including predefined correct abstentions. B percentage minus A percentage >= -5 points. One answer is 3.125 points: B may lose one net correct answer, not two. Report paired errors and strata; this is not a powered scientific claim. |
| Unsupported answers | Answers containing at least one material claim not supported by scene evidence / all substantive answers <=15%. Abstentions are separate; zero substantive answers is inconclusive, not success. |
| Abstention precision | Correct unanswerable abstentions / all abstentions >=75%. Also report recall over unanswerable items and answer coverage to expose over/under-abstention. No denominator means inconclusive. No new recall gate is silently added. |
| Traceability | Substantive answers with resolvable version-bound references that actually support the material claim / all substantive answers >=90%. A reference that merely opens is insufficient. |
| Spatial errors | At most3 erroneous relational responses in the predefined relational subset; report subset size, abstentions and missed questions separately. |
| Resources | Per-request and batch latency, hardware, memory, preprocessing/storage and errors recorded; no latency/cost pass threshold until a host is known. |

For 32 substantive answers, unsupported claims permit at most4 items (5/32 fails); traceability requires at least29 (28/32 fails). For other coverage, use the actual denominator and ceiling/floor arithmetic. Zero-denominator or missing-stratum results cannot be promoted as a pass.

## Verified use and failure conditions

Baseline problem: a high-level JSON proposal and reference summary do not identify a reproducible input pack or worker-accessible runtime. Smallest change now is this review plus interface/scoring specification, consumed by the incumbent Head Chef during foreground scoping. No specialist is represented as acquiring new scientific expertise.

Acceptance for preparation: full design hash verified, addendum separated from design supersession, missing pack named once, scoring arithmetic checked, publication/index references agree. Later acceptance requires lawful approved assets, repeatable model execution, blind scored pack, evidence-preserving receipts and retrieval by an actual intended worker. Mark saved, consumed, applied and outcome-verified separately.

Failure/reversion: if the pack differs, required provenance cannot be produced, terms/host are unavailable or candidate violates evidence gates, retain the baseline and stop the affected experiment. Reconsider the fallback only with the documented tripwire. No access reset, automatic code installation, model execution, new observation or production deployment is part of this decision.
