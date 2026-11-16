# Development Plan

Last updated: 2026-11-16

## Goal and current priority

Build an extensible science-video framework for AI agents: discover typed tools, compose original visuals, inspect results, make targeted edits and export reproducible videos. Content meaning stays upstream; Project Graph remains the single creative model; templates are optional.

Prioritize a small demonstrated creation-and-repair workflow on Remotion. Programs should perform structural, temporal and geometry checks and return evidence to the AI. The AI uses node identities and diagnostics to choose edits. Representative rendered frames, media validation and human review remain necessary for final-output correctness and presentation quality.

[Platform Vision](PLATFORM_VISION.md) owns durable principles, [Architecture](ARCHITECTURE.md) implementation boundaries, and [P1.1 Acceptance](P1.1-ACCEPTANCE.md) measurable exit gates. Test counts and catalogue size are not product-completion percentages.

## Main is the delivery baseline

1. Start reviewable increments from current main and preserve existing edits.
2. Run focused local checks and full repository CI. Inspect the exact PR head, current base and CI result before merging; update/retest integration if the base changes.
3. Merge completed work promptly after successful CI and review. A draft branch alone is not delivered work.
4. Verify the resulting main commit and its push CI. Report the main SHA, CI link, delivered behavior and remaining gates.
5. Keep code, meaningful tests and scoped documentation together. Older or unrelated passing checks cannot close a new acceptance gate.

Recorded baselines are historical evidence, not aliases for main HEAD. [PR #1](https://github.com/xxbo/ScienceMotion-AI/pull/1) merged chart drawing and snapshot scene-selection fixes. Main `020ae447bb81a6e727872188689407a14abac60c` passed [CI #43801547940](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43801547940): 185 tests, production chart pixel checks and the legacy narrated video pipeline.

## Current capability and limits

| Area | Delivered foundation | Remaining work |
| --- | --- | --- |
| P0 media | Remotion 1080p, Mandarin TTS, Episode validation, SVG storyboards and MP4/audio checks | Measured narration/caption alignment, mixing/ducking and polished long-form presentation |
| P1.0 project | ProjectDocument 1.1.0, revisions, node edits, local CAS, migrations, snapshots and restore | Integrated creative acceptance belongs to P1.1 |
| P1.1 A–E platform | Discovery, Gateway, execution evidence, artifacts/references, version pins and guarded switching | 300-entry synthetic test and executable extension acceptance |
| P1.1-F host | Trusted in-process single-writer host, scoped grants/limits, recovery and Patch 1.3.0 | Isolation and distributed guarantees belong to later phases |
| P1.1-G creation/render | Scene/text/shape/path/chart/transform/keyframe tools; snapshot PNG/MP4; chart SVG/pixel regressions | Two-topic creation, targeted text/animation edits and integrated restore evidence |
| Inspection I1 | Read-only model diagnostics, declared shape/chart bounds and exact frame coverage | Browser layout and final visual quality remain unchecked |
| P1.1-H AI acceptance | Deterministic host scenarios and a discoverable tool surface | Complete integrated scenario, real-AI trial and human visual review |

The built-in workspace catalogue has 18 executable tools including inspection and administrative operations. This does not mean 18 distinct creative capabilities. Geometry JSON catalogue fixtures and future synthetic entries are counted separately. `assets.import` is still planned.

## Next delivery sequence

Current product checkpoint: review the [30-second CPU-cache sample](showcase/README.md) before adding more infrastructure. It demonstrates existing generic 2D tools with external narration finishing. The authoring script and fixed video provide an observable baseline; they do not close the two-topic, restore, real-AI or human-review gates. Prioritize the user's feedback on clarity, pacing and visible animation when selecting the next increment.

| Order | Increment | Completion evidence |
| --- | --- | --- |
| 1 | Inspection I1: expose model checks through the public host | Typed report; permission/hash/frame/work limits; repair/recheck/restart scenario with zero render/vision calls; CI and main integration |
| 2 | Inspection I2: measure actual browser layout | Text metrics after fonts load, viewport/crop evidence, node/frame identities and seeded overflow cases in the production composition |
| 3 | Two-topic creation and restoration | Two 10–30 second briefs use the same public tools/renderer; inspect, revise, preview, export, restart and restore |
| 4 | Extension and real-AI trial | 300 synthetic manifests, one executable extension, and a model using discovered schemas/diagnostics with recorded calls and interventions |
| 5 | P1.1 closure | Gates R/I/C/Q/X/A mapped to one integrated commit/CI run and reviewed outputs |

Land each verified increment independently. I2 is a bounded measurement feature, not a new Studio UI or a general autonomous video critic. Additional infrastructure needs an acceptance case that depends on it.

## Programmatic inspection strategy

```text
Approved brief -> public tools -> immutable Project Graph snapshot
  -> structural/model checks -> actual browser layout measurements
  -> structured issues -> targeted tool edits -> snapshot and recheck
  -> representative preview review -> export and media validation
```

Derived measurements are evidence attached to the canonical snapshot, not another editable scene/timeline model. Source review, model projection, browser layout and final pixels establish different things.

### I1 — Model inspection implemented in this slice

- Expose `inspect.snapshot({ snapshotId, frames? })` through Plugin/Registry/Gateway with only `snapshot.read`.
- Validate ownership, canonical document/schema/references and snapshot identity/hash.
- Return versioned snapshot/revision evidence, grouped issues, node/track/scene IDs, checked frames, truncation and explicit unchecked domains.
- Reuse render-model diagnostics. Check transformed declared shape/chart rectangles; edge crossings remain warnings because exits and bleeds may be intentional.
- Inspect all frames up to 120 frames; for longer sequences sample shot boundaries, animation keys/neighbours and uniform probes within a 120-frame cap. Report omitted candidates and unsampled frames.
- Bound frame selection, projection work and issue count. Reject excessive explicit requests rather than silently reducing their coverage.
- Detect an intermediate-frame motion defect, repair keyframes through tools, recheck, preserve old-snapshot results and repeat after restart without rendering.

Details: [Snapshot inspection](P1.1-G-INSPECTION.md). Tool success means inspection executed. `no-issues-detected` is restricted to named checks and frames; it is not a final-video pass.

### I2 — Actual layout measurements, next

- Use the production Remotion/browser composition with the same snapshot. Wait for fonts before measuring actual text lines and boxes.
- Return measured versus declared bounds, overflow/crop amounts, node IDs and frame ranges. Label measured, estimated and unsupported results.
- Make clipping/overlap policy explicit. Intentional overlap, transparent padding and offscreen transitions are not unconditional errors.
- Include scene/animation boundaries and motion samples. Adaptive refinement/analytic extrema need their own evidence; endpoint checks do not cover intermediate motion.
- Add seeded overflow, font fallback and renderer-default mismatch cases. Retain pixel regressions to detect faults in the measurement/render bridge.
- Reuse unchanged evidence when snapshot, measurement version and environment identities match. Broader cache infrastructure stays later.

### Quality and cost evidence

Record model-check time, browser-measurement time, encoded preview frames, visual-model calls, seeded defects detected/missed and resulting repairs. Establish a baseline before setting an efficiency target; do not infer savings percentages from one fixture.

Model/geometry checks do not prove text layout, arbitrary path extents, occlusion, final pixels, audio synchronization, scientific correctness or visual appeal. Claims and narration still need approved-source checks. Human visual review remains Gate Q; assistant preview inspection is recorded separately.

## P1.1-H integrated acceptance

Start from an empty project, discover tools, create content, save a snapshot, inspect, preview, edit selected text/position and animation, export, restart, restore and compare. Include failure/safe retry and plugin version switching, with a failed upgrade preserving the previous usable implementation.

Both topics use the same public contracts; no new topic-specific TSX scene is allowed. Preserve approved content and unrelated state during repairs. Compare canonical data, asset identities and declared frame tolerances rather than requiring byte-identical MP4s across environments.

The real-AI trial separately records model/provider, approved brief, manifests, calls, revisions, diagnostics, artifacts and human intervention. Scripted regression does not satisfy that trial. General planning and autonomous visual critique remain P1.4.

## Retained reliability boundaries

Preserve owned idempotency reservations and input-hash matching, explicit uncertain outcomes, restart evidence, cooperative timeout/cancellation accounting, publication/recovery ordering, retained-snapshot asset protection, guarded plugin versions and session/plugin/tool grants.

Operation is trusted, in-process and single-writer. Worker termination, enforceable compute budgets, cross-process transactions and third-party sandboxing are later capabilities. Detailed evidence remains in [F execution](P1.1-F.md), [F project/assets](P1.1-F-PROJECT-ASSETS.md), [F host](P1.1-F-CREATIVE-HOST.md) and [E versions](P1.1-E.md).

## Later roadmap

| Stage | Responsibility |
| --- | --- |
| P1.2 | Isolated single-host workers, progress/cancellation and enforceable resource limits |
| P1.3 | Broader project/timeline, geometry, SVG/charts, animation, audio/captions and inspection tools |
| P1.4 | Provider-independent planning and autonomous inspection/repair |
| P1.5 | Multi-tool composition, performance evidence and new engines without orchestration rewrites |
| P2 | Advanced motion design, Three.js/Blender, Manim, simulation, cinematography and audio |
| P3 | Research/LLM/TTS/media providers, claims/sources, asset provenance and licensing |
| P4 | Remote workers/storage, resumable/batch exports, metrics and optional Studio UI |

Defer marketplace/distribution/signatures, automatic dependency solving, multi-plugin upgrade transactions, distributed storage/idempotency and elaborate GC scheduling until a demonstrated workflow needs them.

## Historical acceptance evidence

| Baseline | Evidence |
| --- | --- |
| P1.0 project | `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`, [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025) |
| Reviewed A–E | `26f20bab6b56a6aa8774c80e5da25db84d00fefb`, [CI #43463301921](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43463301921), 84 tests |
| F execution | `2566bd0de8b95b27a6adeeeb188c5d854f2b73e5`, [CI #43612600513](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43612600513) |
| F host | `9e936b7ad15a49b9cad572e48e9b398e6852f5aa`, [CI #43783296488](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43783296488), 170 tests |
| Generic Project Graph | `c826aa56c1c0d9c6ff977e97f0ae724d1e9310cb`, [CI #43786811086](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43786811086), 175 tests |
| Snapshot render | `f56a42ab22ddbfc15272d64c3eebe1622bf4e0e6`, [CI #43788856539](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43788856539), 177 tests |
| Chart/scene fix on main | `020ae447bb81a6e727872188689407a14abac60c`, [CI #43801547940](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43801547940), 185 tests |
