# Gaussian L1 — bounded scope and evaluation specification v1.0.1

Status: REVIEWED DESIGN / NONEXECUTING SPECIFICATION. Foreground-assisted, September 7, 2026. Maintainer: ChatGPT Head Chef in the existing implementation function; scientific claims remain provisional. No model, host, tool endpoint or worker capability was installed.

## Decision and exact inputs

Retain **SplatTalk as provisional first pipeline**, GaussianVLM as alternative after an evidenced checkpoint/dual-repository blocker or an explicit packaging choice. Track A's opposite preference remains a documented disagreement; Track A itself is absent from this handoff. Do not switch merely because the addendum is newer.

The supplied Gaussian_L1_v1_1_Head_Chef_Handoff(1).zip contains the complete L1_DESIGN_SUPPLEMENT_v1.1.md, 7,438 bytes, SHA-256 **905516a6a43c502002c0763d5e12a9ea8d1b019ff78cdf646cce355bd529e1e8**. Its matching L1_INDEPENDENT_REVIEW_v1.1.md is an exact-version text review, not a benchmark. FULL_REPORT.md is available. TRACK_B was subsequently retrieved in the owner-supplied September 7 handoff; it proposed three scenes/32 questions but never supplied a concrete selection. The original locked-size wording is not evidence of populated inputs. Preserve the design's evidence cutoff 2026-09-06T23:45:18Z (September 6, 7:45:18 p.m. EDT).

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

## Concrete evaluation preparation — September 7, 2026

**Foreground-assisted construction:** the owner supplied TRACK_B_EVALUATION_HANDOFF_20260907.zip (24,082 bytes; SHA-256 b714f0fbda16bf6e0bca6c05bdbafe71f1e8ee109e1afe3315884f0a8f163e21) and explicitly authorized the first concrete selection. All 14 non-manifest hashes match. HANDOFF_MANIFEST.json self-listed hash 3cb711e89c9175e222a5cc4e0e6100c51a74e368f67d4cf1ec7cf87e632058a7 differs from actual adfbe7989261825945516401c562b816e4fd3aa9b3135456d9b9adc710969b48. Original archive and design history remain unchanged. Historical concrete scenes/questions recovered: zero. Do not request recovery of that nonexistent selection again.

**New package v0.1.0, created 2026-09-07T17:20:05Z (1:20:05 p.m. EDT):** SQA3D Zenodo7792397 v2, balanced-v1 validation annotations, archive SHA-256 b3a41e741e924df21afa56379b0a25b0c5c9f3b7b01585ec839e4b3354551fa9. Three fixed scenes (scene0011_00, scene0217_00, scene0307_00); 18 unique populated source questions (8 straightforward, 10 relational). Those are local textual review categories, not native SQA3D labels. All18 answer/pose records match source; scene-grounded evidence validation is pending. Zero scene assets/posed views; zero model runs. The full 32-item evaluation is not ready.

**Remaining14 slots:** eight ambiguous and six unanswerable require a small explicit design amendment for newly authored, scene-grounded challenges; no gold labels or historical IDs were invented. Keep the three scenes and18 source questions. First obtain permitted scene bundles and verify asset provenance; existing ScanNet approval is not established and no agreement was signed. Then an authorized preparation actor can construct and independently adjudicate those14 new challenges under the amendment, before any candidate output. The owner retains that amendment decision. Do not silently substitute32 answerable questions or treat missing assets as scientific unanswerability.

**Responsible next actor:** ChatGPT Head Chef / existing implementation function for preparation after the specific category/asset gates; existing authorized data custodian or owner for permitted scene access. Candidate-only and owner/evaluator bundles are separate. The owner/evaluator bundle retains source answers, poses, rubric, selector/validator and original handoff; none is to be sent wholesale to ordinary workers or public observation summaries. Full manifest SHA-256: 9d89cf4f19e57d256eaba3859a2d548065169c97909d92463250ca06a190bf41. Exact reproduction and source/hash/structural checks pass; full category coverage fails honestly at18/32. Saved preparation does not establish model capability, scientific blinding or provider adoption.

This preparation has no host or spending prerequisite. Running later needs an identified owner-controlled GPU host and supported worker-callable interface, asset-specific terms clearance, hash-pinned checkpoints/dependencies, scene artifacts and capacity estimate. None is granted or claimed by this specification.

## Proposed worker interface; not a registered endpoint

Keep the design's gaussian_spatial_qa request/response shape. Proposed adapter contract:

- Request: scene_id plus scene_version content hash; question_id plus UTF-8 question hash/text; pipeline and immutable pipeline_version/checkpoint hash; requested outputs; region type none/bbox/gaussian_ids. Record coordinate_frame and units for any region/measurement. Static L1 requires time_interval=null. Reject unsupported region modes explicitly rather than pretend arbitrary splat/ROI support.
- Inputs receipt: exact scene/feature/view artifacts, preprocessing version, model/checkpoint, prompt/config version, decoding settings, run identifier and timestamps. Source/reconstruction cutoff is separate from execution time.
- Response: status ok/abstain/error; answer or null; typed support_refs resolving into the exact scene/view version; measurements only if actually computed with method and units; limitations and brief uncertainty reasons; provisional=true. This is evidence provenance, not hidden reasoning.
- Failure: distinguish missing asset, unsupported input, unavailable model/host and execution error. Never substitute a fabricated answer or another observer's authority.
- Consumption: intended existing workers can later request and retrieve the same receipt and source references through an authorized tool. A pasted example or JSON schema alone fails worker-access acceptance. Existing storage/receipt format must be selected during implementation; this document creates no production event schema.

## Locked comparison and scoring clarification

Target 3 scenes / 32 questions as proposed by TRACK_B; the new v0.1.0 preparation currently populates18 and keeps14 slots unresolved. Arm A receives posed RGB plus declared object metadata; Arm B receives the Gaussian pipeline with metadata withheld by default, as v1.1 specifies. This compares two complete systems, not the isolated causal effect of representation. Keep held-out ground truth out of inputs. Register any metadata parity variant separately. No LLM-judge-only scoring or render attractiveness.

The following **proposed operational definitions** make v1.1 gates auditable. The v0.1.0 preparation rubric now records the TRACK_B differences explicitly: all32 correctness rather than26 answerable, 90% supporting traceability rather than80% citation presence, abstention precision rather than an inherited4/6 recall gate, relational errors rather than0.5m centroid gating, and record-only latency. No old45% absolute correctness or30-second latency bar is silently retained. Complete the final32-item freeze before running:

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

Acceptance for preparation: full design hash verified, addendum separated from design supersession, historical proposal distinguished from the new partial selection, scoring arithmetic checked, publication/index references agree. Later acceptance requires lawful approved assets, repeatable model execution, blind scored pack, evidence-preserving receipts and retrieval by an actual intended worker. Mark saved, consumed, applied and outcome-verified separately.

Failure/reversion: if the pack differs, required provenance cannot be produced, terms/host are unavailable or candidate violates evidence gates, retain the baseline and stop the affected experiment. Reconsider the fallback only with the documented tripwire. No access reset, automatic code installation, model execution, new observation or production deployment is part of this decision.
