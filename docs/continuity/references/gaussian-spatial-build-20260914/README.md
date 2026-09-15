# Gaussian Spatial Evidence Module

**Build reference v1.0.0 · September 14, 2026 · PP3 advisory analysis**

## Decision and status

Use Gaussian Splatting as the Control Room’s **versioned visual scene component**, alongside original images, camera calibration, reviewed annotations and—when necessary—separately validated geometry. Do not make a splat file the authority for facts, measurements, identity or the project’s general memory.

**Recommended first implementation:** one static, lawful scene; reproducible views; an evidence-linked question; an appropriately unanswered question; and a second real authorized consumer. Qualify an existing precomputed scene before funding a new training pipeline when its provenance, source images, cameras and redistribution terms are adequate. That separates viewer/integration problems from training problems.

This document analyzes the owner-supplied briefing using primary papers and project documentation. The briefing’s main structure is retained; qualifications are explicit below. Architecture, schemas and acceptance cases are **proposals**, not vendor features or executed results. No trainer, viewer, scene or model was installed or run here. No dataset was acquired. Scene rights, hardware, budget and current execution capability are unestablished.

Publication of this reference is separate from deployment of a scene or verification of a live website page. Current publication receipts belong outside the document’s own content hash. See [BLUEPRINT.json](BLUEPRINT.json) for machine-readable design and [SOURCES.json](SOURCES.json) for reading coverage. A future reader must not treat an embedded plan as authority to execute it.

## 1. What the supplied explanation gets right

The supplied briefing accurately frames the core task as novel-view synthesis from calibrated images and the representation as explicit anisotropic Gaussians, with position, orientation/scale, opacity and directional appearance. The original method alternates image-fitting with primitive refinement. It does not require a triangle mesh for ordinary splat rendering. [S01, S02]

Its capture → poses → fitting → inspection → export sequence is a useful engineering outline. Splatfacto offers an integrated implementation using gsplat and can export trained splats, but it deliberately evolves beyond the original algorithm. Keep implementation/configuration identities rather than using “3DGS” as one interchangeable binary. [S14]

The four-part authors’ tutorial is a good reading router: foundations, practice, dynamics and surface reconstruction. The survey is useful for discovery. The version currently identified is **2401.03890v9**, revised April 9, 2026; this analysis used its abstract and version metadata, not a complete survey review. [S03, S04]

## 2. Qualifications that change build decisions

| Supplied framing | Qualification from the reviewed sources or our analysis | Consequence |
|---|---|---|
| 100+ fps at 1080p | The project page states at least 100 fps; paper v1 states at least 30 fps. Those are source-specific research claims, not a guarantee for our scene, browser or device. [S01, S02] | Publish actual device, resolution, asset, renderer and frame-time measurements. |
| Sort once per frame, then blend | The original renderer sorts tile/depth instances, not a perfect independent order at every pixel; compositing is approximate in some configurations. [S01] | Include overlapping transparent structures, motion and depth-order artifacts in evaluation. |
| Real time from the start | Fast drawing and a converged, usable reconstruction are different milestones. | Report loading, rendering and training separately; do not label an untrained scene usable. |
| SfM failure leaves nothing to grow | COLMAP initialization is helpful; the original work also reports random initialization in bounded synthetic conditions. [S01, S14] | Treat failed capture registration as a specific input problem, not proof every alternative is impossible. |
| Meshes provide accurate scale and clean surfaces | A representation alone supplies neither verified scale nor completeness. COLMAP documents pose/registration conventions and imperfect meshing outcomes. [S15, S16] | Require a scale reference and geometry validation before metric answers. |
| NeRF means a slow MLP | The original paper itself discusses grids, hash encodings and approaches without an MLP. | Compare named implementations on the same task rather than declare a whole representation family obsolete. |
| Mip-Splatting means no aliasing anywhere | Its filters address defined sampling-rate artifacts. That is not a blanket guarantee across arbitrary pipelines or exports. [S06] | Bind training/filter assumptions to the selected renderer and test zoom/resolution changes. |
| 4DGS and Dynamic 3D Gaussians are one extension | Wu’s system predicts deformations; Luiten’s follows persistent moving primitives. They have different assumptions and output contracts. [S07, S08] | Choose a motion method only for an actual temporal task. |
| SPZ, SOG and Compact-3DGS are equivalent compression steps | SPZ/SOG are formats; Compact-3DGS also changes the learned representation, including view-dependent color. [S17, S22, S26] | Do not assume a compact model loads in a generic splat viewer. |
| A PLY is the scene | Generic PLY may be a point cloud or mesh, not the required Gaussian attributes; camera-pose import creates keyframes, not a scene. [S18] | Validate the producer’s attribute schema, units and transforms, not the extension alone. |
| Original source is free to use in the product | The original trainer’s license restricts use to research/evaluation/noncommercial purposes without additional consent. [S24] | Review the exact implementation and asset provenance before adoption. |

The briefing’s broad comparisons are useful orientation, not evidence that NeRF universally wins on participating media or that photogrammetry always yields watertight surfaces. No exact primary comparative study for those generalizations was supplied. The unnamed Edward Ahn comparison was not used as technical authority.

## 3. Turn the representation into engineering constraints

A renderer evaluates a view-dependent color and an opacity footprint for each relevant primitive, then blends contributions. Its covariance can be expressed as `Σ = R diag(s²) Rᵀ`; normalized rotation and positive scales keep it valid. A local camera projection maps that covariance into an image footprint. [S01]

For our design, the useful implication is not another custom rasterizer. It is a **versioned render contract**: scene identity, exact camera, rendering configuration, output image and their provenance. A novel view is a synthesized result, not a photograph that was actually captured.

Keep camera intrinsics, distortion treatment, pose direction, quaternion ordering, axis convention, image dimensions and every normalization transform explicit. COLMAP’s documented pose is world-to-camera with quaternion `(qw,qx,qy,qz)`; camera position is not the translation vector itself. [S15] Test these conversions with control points and round trips before trusting overlays.

Do not use a Gaussian’s radius as measurement uncertainty or its opacity as calibrated confidence. Neither interpretation is established by the representation. A depth-render option is not automatically an observed range measurement; record the selected depth definition and evaluate it against an independent reference when used quantitatively. The gsplat API exposes depth and feature-rendering capabilities, but those need a task-specific interpretation. [S13]

Do not use primitive array positions as permanent object identities. Training, pruning, editing and compression can change them. Maintain stable region/annotation IDs outside the splat array, linked to asset versions, source observations and any changed mappings.

## 4. Recommended component choices

**Capture/calibration: COLMAP or a verified equivalent.** Preserve the original files, reconstructed cameras and all preprocessing/coordinate mappings. For a first controlled capture, select a static, textured, non-sensitive subject with adequate overlapping views, limited blur and consistent lighting. These are proposed capture criteria, not an instruction to collect a particular place or person. Preserve exclusions and capture failures.

**Training: evaluate gsplat, with Splatfacto only when its workflow is useful.** gsplat supplies CUDA/Python rasterization and related capabilities; Splatfacto adds training, checkpoint/viewing and export orchestration. The documented memory figures are examples, not a hardware specification for our laptop. Do not install both as unrelated stacks. No compatible GPU or build environment is established by this reference. [S12, S14]

**Browser viewing: evaluate the self-hosted SuperSplat Viewer/PlayCanvas path.** The editor, viewer and splat-transform components are MIT-licensed; the hosted platform is a different product. Prefer a reviewed viewer embedded in the existing Control Room with its normal access controls, not another public hosting account. Local editing, export and upload have different privacy effects. Export may require WebGPU even when a chosen display path has different requirements. [S18, S19, S20]

**Unity: an optional downstream consumer.** Aras describes a playground with platform constraints and limited planned development; its permissive viewer license does not clear upstream trained assets. It is not our browser default or a proof of production support. [S23]

**Geometry: add only for the question.** Surface, metric, contact and collision tasks should use separately validated geometry/depth, potentially from 2DGS, GOF or another appropriate method. Keep the visual asset and geometry artifact distinct even when they share coordinates. [S05, S09]

Before an executable trial, bind exact releases, dependencies, model/checkpoint, input license, allowed destination and cost/resource limits. A root Apache-2.0 license for gsplat is not clearance for every optional extension or dataset. [S25] Publicly downloadable data is not automatically authorized for redistribution to the whole team or website.

## 5. The product contract: one scene, several evidence layers

The following is a proposed contract, not an installed API.

**Scene bundle.** Store an immutable scene/version ID; original permitted imagery; intrinsics/extrinsics; reconstruction and preprocessing identities; full-fidelity trained output/checkpoint where permitted; a web-delivery derivative; optional validated geometry; reviewed semantic annotations; capture and processing times; rights/access policy; uncertainty/coverage limits; evaluation and review records. Every derivative references its parent bytes and transformation settings.

**View bundle.** Given an authorized scene and camera request, return the rendered image, exact pose/intrinsics, dimensions, renderer/version/settings, asset identity, relevant supporting original images, and explicit coverage limitations. “Relevant” source selection must be justified; nearest camera position alone is not proof of visibility. Persist the actual image bytes. Similar GPU renders need tolerance-based comparisons; identical file hashes are not a universal reproducibility promise.

**Question bundle.** Retain the question, scene/version, selected view IDs, original evidence, method/tool versions, result, uncertainty and reviewer disposition. Classify the answer as an observation from captured evidence, a reconstruction-derived estimate, a validated metric calculation, or insufficient evidence. A generated completion of an unseen region stays hypothetical.

**Reuse bundle.** A second authorized participant retrieves that exact scene and accepted method, performs a real assigned task and returns evidence. Two simulated fixture labels or two copies of one answer do not demonstrate cross-role reuse. Store actual reader/access and result receipts separately from publication.

This creates a shared spatial workspace while retaining the existing ledger as authority for tasks, permissions and accepted results. Splats are not a replacement for exact financial data, project notes or model memory.

## 6. Questions the module should and should not answer

Consider a permitted tabletop scene containing two labeled objects. This is an illustrative test design, not a captured dataset.

“Show the red object from the selected camera” requires the exact view and object annotation. “Which object is left of the other?” must specify the reference frame: camera-relative is not world-relative. Both answers should link to captured supporting evidence rather than claim an unobserved surface is known.

“How far apart are they?” requires validated scale, units, geometry, the chosen endpoints and an error estimate. Without those, return unknown scale or an explicitly non-metric estimate—not invented centimeters. “What is behind the covered side?” requires another observation; a plausible synthesized view is not proof.

Use these cases to distinguish image realism from semantic reliability, geometry accuracy and justified uncertainty. A photo-realistic result can fail all three of the latter tests.

## 7. Extensions: select against a failure, not a popularity list

| Method | Trigger for evaluation | Keep separate |
|---|---|---|
| 2DGS | Surface consistency and mesh quality fail a defined geometry task. | Rendering quality, completeness, scale and watertightness still need evaluation. [S05] |
| Mip-Splatting | Zoom, resolution or sampling-rate changes introduce artifacts. | Training and rendering filter assumptions; do not silently mix incompatible exports. [S06] |
| GOF | A compact extracted surface is needed from a regularized Gaussian field. | Extracted mesh is a new artifact with its own validation. [S09] |
| Wu 4DGS | A real time-varying scene is required. | Deformation network/configuration and timestamps, not just a static PLY sequence. [S07] |
| Dynamic 3D Gaussians | Persistent tracks and motion correspondence are the task. | Synchronization, identity continuity, occlusions and tracking validation. [S08] |
| Compact-3DGS | The model’s memory/storage tradeoff needs representation-level change. | Its neural-color component and decoder compatibility. [S26] |
| SOG/SPZ and LOD | Transfer or display budgets fail. | Compression loss, decoder version, camera/axis transforms, annotations and measured quality. [S17, S22] |

Defer dynamics and relighting until the static evidence workflow works. Relighting needs an appearance/material/illumination model beyond treating fitted directional color as physical material. A 4D recording is not a simulator of arbitrary future actions.

## 8. Compression without destroying evidence

Keep an immutable permitted master; publish compressed derivatives with their own hashes and decoder/configuration identities. Aras distinguishes storage reduction from runtime memory reduction and shows why dropping SH detail changes appearance; the follow-up explores codebook compression. Those examples are useful design tradeoffs, not our measured compression gains. [S10, S11]

Use documented SOG/SPZ compatibility for the actual producer and consumer version. Record SH degree, quantization, spatial transforms, point counts and LOD policy. Different viewers can disagree even when both accept a filename. Avoid generic conversion instructions that silently run script-based input. [S17, S18, S21, S22]

Compare the master and derivative at fixed views, including reflective surfaces, thin structures and the supported zoom range. Measure both encoded bytes and peak CPU/GPU working memory. A smaller download is not necessarily a smaller decoder working set. Do not infer confidence, identity or metrology from a codec’s visually acceptable output.

## 9. A staged acceptance plan

**Stage A — reference and input admission.** Select one lawful precomputed scene with enough source/camera evidence to support the test. Capture its rights, redistribution limits, complete required bytes and identities. A ready-made splat without source evidence may test rendering, but cannot satisfy the full evidence acceptance case.

**Stage B — viewer and reproducible evidence.** Qualify loading, supported poses, source-view retrieval and a saved render bundle in the existing interface. Show a static fallback with version/limits on unsupported devices; do not label a poster image an interactive scene.

**Stage C — grounded question and second consumer.** Answer one supported question; refuse one unsupported claim; test an uncalibrated distance; have a different actual authorized participant use the same accepted scene/method and return an independently reviewable result. Measure owner relay rather than hide it.

**Stage D — one controlled reconstruction.** Only after a named data/runtime/compute approval, evaluate COLMAP plus the selected trainer on one bounded capture. Preserve setup/version, input split, settings, seed where applicable, actual process IDs, checkpoints, costs and failure evidence. Avoid near-duplicate frame leakage when evaluating held-out views; record whether test poses were estimated using all images or only the training subset.

**Stage E — optional extensions.** Select only the measured failure addressed by anti-aliasing, geometry, compression or dynamics. Retain the static accepted baseline and comparison denominator.

Proposed acceptance criteria are enumerated in BLUEPRINT.json. Core correctness/access/no-duplicate requirements are hard gates. Performance targets must be declared before the run for the chosen device and workload. A possible interactive target is at least 30 fps with p95 frame time no more than 33.3 ms; this is a proposed engineering target, not a published achievement or a requirement for every use case. Report cold-load time separately.

Use image metrics on held-out captures for appearance, separate ground-truth checks for geometry/semantics, and actual task/use receipts for product success. Do not equate improved PSNR/SSIM/LPIPS with a truthful answer. Preserve comparable test sets and all failures rather than growing test counts and calling that speed improvement.

## 10. Integrate with the team and safe execution

Head Chef scopes and coordinates; Codex implements under an exact work order; permitted Grok participants provide attributed sources and observe within their contract; specialists own relevant findings; Worker5 communicates accepted status. A future authorized Claude Librarian can curate scene IDs, sources, derivatives, supersession and small evidence packs. This reference does not activate that role or change existing scope.

Use the existing trusted-return pattern for original bytes, independent policy, results, review and consumer feedback. The accepted F2 work is relevant to failure handling, but its in-memory hold must not be presented as durable restart recovery. Do not repeat completed work or change the current integration merely to publish this analysis.

A real job needs a durable operation ID and intent, an accountable executor, pinned inputs, native submission/result identifiers, actual limits and a reconciliation path. Proposed states: PREPARED, SUBMITTED, RUNNING, RETURNED, VERIFIED, FAILED, and UNKNOWN_RECONCILE. Preserve cancellation requests separately from confirmed termination. On a missing reply, reconcile the existing operation rather than launch a second training job.

Apply record-level access to scene manifests, images, models, annotations and rendered views. A screenshot or cache can expose restricted source content; public reference text must not embed protected scene data. Disallow arbitrary filesystem paths, unapproved URLs and executable model/scene loaders. Keep credentials, private evaluator answers and hidden reasoning out of traces. Required original evaluator material remains in its own protected boundary.

## 11. Website, future availability and succession

The desired site entry is **Sources & Decisions → Gaussian Spatial Module**, linked with the [tool register](../tool-leverage-20260914/README.md) and [Grok leverage register](../grok-build-leverage-20260914/README.md). The human page and machine blueprint should carry the same reference/version identity, source links, proposed/implemented distinction and next-stage state. This is reference content, not a new runtime or second portal.

For actual website completion, reconcile an existing item; use the supported content publisher or approved canonical checkpoint generator; verify the rendered page and downloadable JSON by their actual version/bytes; retain the real URL and publication receipt. A GitHub reference alone does not establish website display. The present context has no compatible native Sites writer; the existing maintenance procedure describes a protected checkpoint-generator path. No canonical pointer or operational checkpoint is modified here.

Keep one stable entry and immutable versions, a manifest over retained content, a separate publication/readback receipt, and actual reader-use receipts. Avoid expiring signed URLs as canonical references. Source links can disappear, so permitted evidence needed for decisions must be retained under its own terms; a hash without bytes is insufficient. Availability still depends on storage, access and maintenance—no service or file can be promised permanent by a chat response.

PP3’s private continuation records point to this public reference and preserve the wider mission, current F2 handoff, earlier reference catalogs, unsent work, holds and observed capability limits. A successor should first read that small current-state entry, then retrieve only the relevant immutable source. Full transcript recovery, inherited permissions and automatic chat creation are not claimed.

## Sources and reading coverage

The following are the reviewed primary sources. Most documentation links are mutable; the paper versions and returned license-blob identities above are explicit. No executable release is selected. The source register records limitations, including landing-page-only coverage where applicable. No X sources were needed.

- **S01 — [Kerbl et al., 3DGS paper](https://arxiv.org/html/2308.04079v1)**. 2308.04079v1. Foundations, representation, optimization, sorting, limitations; selected text, not a new benchmark.
- **S02 — [Original 3DGS project](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)**. mutable page. Abstract and stated performance; distinguish the project page from paper v1.
- **S03 — [Chen and Wang survey](https://arxiv.org/abs/2401.03890v9)**. 2401.03890v9. Abstract and version history only; not a full survey or all-method audit.
- **S04 — [Authors’ 3DGS tutorial](https://3dgstutorial.github.io/)**. 3DV 2024 landing page. Four-part learning route; linked slide decks and videos were not reviewed in full.
- **S05 — [2D Gaussian Splatting](https://surfsplatting.github.io/)**. SIGGRAPH 2024 project. Oriented surface disks, perspective-aware rasterization and geometry regularization.
- **S06 — [Mip-Splatting](https://niujinshuchong.github.io/mip-splatting/)**. CVPR 2024 project. Sampling-rate artifacts; 3D smoothing and 2D Mip filtering.
- **S07 — [Wu et al., 4D Gaussian Splatting](https://guanjunwu.github.io/4dgs/)**. CVPR 2024 project. 3D Gaussians plus encoded spatiotemporal features and deformation prediction.
- **S08 — [Luiten et al., Dynamic 3D Gaussians](https://dynamic3dgaussians.github.io/)**. 3DV 2024 project. Persistent primitives, time-varying motion/rotation and local rigidity.
- **S09 — [Gaussian Opacity Fields](https://github.com/autonomousvision/gaussian-opacity-fields)**. mutable README. Regularized opacity field and adaptive mesh extraction; code was not executed.
- **S10 — [Aras: Making Gaussian Splats smaller](https://aras-p.info/blog/2023/09/13/Making-Gaussian-Splats-smaller/)**. 2023-09-13 article. Storage versus runtime memory, quantization and SH tradeoffs.
- **S11 — [Aras: Making Gaussian Splats more smaller](https://aras-p.info/blog/2023/09/27/Making-Gaussian-Splats-more-smaller/)**. 2023-09-27 article. SH codebooks and quality tradeoffs; no local replication.
- **S12 — [gsplat overview](https://docs.gsplat.studio/main/)**. main documentation. CUDA/Python rasterization library and documented features; no installed release selected.
- **S13 — [gsplat rasterization API](https://docs.gsplat.studio/main/apis/rasterization.html)**. main documentation. Camera/depth/feature rendering controls; exact API options must be release-bound.
- **S14 — [Nerfstudio Splatfacto](https://docs.nerf.studio/nerfology/methods/splat.html)**. mutable documentation. gsplat backend, COLMAP initialization, checkpoint/view/export workflow; not identical to original trainer.
- **S15 — [COLMAP output formats](https://colmap.github.io/format.html)**. mutable documentation. Intrinsics, world-to-camera pose, quaternion order, identifiers and reconstruction files.
- **S16 — [COLMAP FAQ](https://colmap.github.io/faq.html)**. mutable documentation. Selected pose-prior, geo-registration and mesh limitations; no whole FAQ audit.
- **S17 — [PlayCanvas splat formats](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/)**. mutable documentation. PLY, SOG, streaming and SPZ roles; vendor size ratios are not project measurements.
- **S18 — [SuperSplat import/export](https://developer.playcanvas.com/user-manual/supersplat/editor/import-export/)**. mutable documentation. Version-specific imports/exports, camera-file meaning and WebGPU export prerequisite.
- **S19 — [SuperSplat viewer self-hosting](https://developer.playcanvas.com/user-manual/supersplat/viewer/self-hosting/)**. mutable documentation. Self-contained versus packaged export, source/runtime prerequisites and hosting distinction.
- **S20 — [SuperSplat platform and licensing](https://developer.playcanvas.com/user-manual/supersplat/)**. mutable documentation. MIT editor/viewer/transform versus proprietary hosted platform.
- **S21 — [SplatTransform](https://developer.playcanvas.com/user-manual/splat-transform/)**. mutable documentation. Explicit conversions, versions and transforms; script-based input is not admitted.
- **S22 — [Niantic SPZ](https://github.com/nianticlabs/spz)**. mutable README. Compressed format, coordinate system, versioned decoding and quantization; no release selected.
- **S23 — [Aras Unity renderer](https://github.com/aras-p/UnityGaussianSplatting)**. mutable README. Experimental renderer, platform limits and separate asset-license warning.
- **S24 — [Original trainer license](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/LICENSE.md)**. Git blob 18445c6d34aedbf1ab9d282223f8f10ce38cd79a. Research/evaluation/noncommercial scope and commercial-consent requirement; no legal clearance inferred.
- **S25 — [gsplat license](https://github.com/nerfstudio-project/gsplat/blob/main/LICENSE)**. Git blob 1dc520ba6aa1ff169e95250cf0398beb3757590a. Apache-2.0 root license; dependencies, data and model terms remain separately checked.
- **S26 — [Compact 3D Gaussian Representation for Radiance Field](https://ieeexplore.ieee.org/document/10655367/)**. CVPR 2024, DOI 10.1109/CVPR52733.2024.02052. Publisher abstract: pruning, neural view-dependent color and geometric codebooks; not just an interchange codec.
