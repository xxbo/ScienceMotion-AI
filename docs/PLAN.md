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
| P1.1 A–E platform | Discovery, Gateway, execution evidence, artifacts/references, host version switching with failure preservation, public extension and 300-entry synthetic acceptance | Remote package/code loading and automatic version selection remain deferred |
| P1.1-F host | Trusted in-process single-writer host, scoped grants/limits, recovery and Patch 1.3.0 | Isolation and distributed guarantees belong to later phases |
| P1.1-G creation/render | Scene/text/shape/path/chart/transform/keyframe tools; snapshot PNG/MP4; two-topic creation/edit/export/restart/restore and real dependency recovery | Broader media import/audio/captions and professional presentation remain later work |
| Inspection I1 | Read-only model diagnostics, declared shape/chart bounds and exact frame coverage | Final visual quality remains unchecked |
| Inspection I2 | Production-browser text lines, actual element boxes, viewport overflow and heuristic font fallback; no screenshot/video encoding | Exact glyph fonts/ink, occlusion, cross-session evidence caching and visual quality remain open |
| P1.1-H AI acceptance | Two-topic deterministic public-tool scenario, failures/retries, frame comparisons and persisted evidence | Local AI-client interface, real-AI trial and human visual review |

The built-in workspace catalogue has 19 executable tools including inspection and administrative operations. The two-topic scenario adds one executable test extension using public services; one JSON catalogue-only manifest and 300 synthetic scale entries (100 IDs × 3 versions) are counted separately. Plugin administration is an application API, not an additional AI tool. `assets.import` is still planned.

## Next delivery sequence

Current checkpoint decision (2026-11-16): continue engineering and defer the user's effect review to the final acceptance. Keep the [30-second CPU-cache sample](showcase/README.md) as the comparison baseline. Automated checks remain required for every increment. The sample does not close the two-topic, restore, real-AI or human-review gates.

P1.1 is still active. I1, bounded I2 measurement, the [two-topic workflow](P1.1-CREATIVE-LOOP.md), [host plugin switching and catalogue scale](P1.1-PLUGIN-SWITCH-SCALE.md) are implemented. The [acceptance checklist](P1.1-ACCEPTANCE.md) has 20/25 closed items: R 6/6, I 4/5, C 5/5, Q 2/3, X 3/3 and A 0/3. Items differ in scope; this is not an effort percentage. Final visual review stays an explicit pending gate, not a prerequisite for continuing engineering.

| Order | Increment | Completion evidence |
| --- | --- | --- |
| 1 — implemented | Inspection I1: expose model checks through the public host | Typed report; permission/hash/frame/work limits; repair/recheck/restart scenario with zero render/vision calls |
| 2 — implemented | Inspection I2: measure actual browser layout | Font-ready line/element boxes; scoped reports; seeded text/motion/font cases; repair/recheck/restart and production-pixel correspondence |
| 3 — implemented | Two-topic creation and restoration | Two 12-second briefs use the same public tools/renderer; inspect/repair, text/motion edits, preview/export, failed mutation/idempotent retry, restart and restore with real data dependencies |
| 4 — implemented | Integrated extension/version and scale acceptance | Public host administration pauses/drains calls, switches exact versions and preserves the old version on failed upgrade; both topics continue editing; 300 synthetic manifests and timings recorded |
| 5 — next | Real-AI trial | Thin local AI-client interface; discovered schemas/diagnostics, real model decisions, calls/revisions/outputs and interventions; retain deterministic regression alongside it |
| 6 | P1.1 closure and effect review | Human review of both fixtures; gates R/I/C/Q/X/A mapped to one integrated main commit/CI run and reviewed outputs |

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

### I2 — Bounded browser layout measurements, implemented

- `inspect.layout({ snapshotId, frames? })` requires only `snapshot.read`, runs the same production `ProjectGraph` composition, waits for fonts and reads DOM/Range geometry. Remotion `imageFormat: none` skips screenshot/video encoding; a nonvisual Artifact returns JSON measurements.
- Versioned reports bind measured versus declared boxes, line counts, overflow amounts, node/scene/frame identities and browser metadata to the immutable snapshot hash. The host rejects wrong frame/scene/viewport/node identities.
- Clipping and text-size excess are warnings: offscreen movement or a larger text block can be intentional. Overlap/occlusion is not evaluated.
- Auto sampling uses boundaries, animation keys and uniform probes, capped at 12 frames. Explicit requests are validated; omitted candidates and unsampled frames are disclosed. Per-frame/node/text/model limits bound browser work.
- A missing-font width probe is explicitly heuristic. Computed CSS font-family alone is not proof of the exact font or glyph fallback. Exact glyph fonts, glyph ink and SVG path extents remain unchecked.
- CI seeds text overflow, an intermediate-frame exit and a missing font, edits through tools, rechecks old/new snapshots after restart, and compares measured line boxes with production PNG ink. Two regression PNGs are separate from the zero-image-encoding inspection path.
- Reports carry browser/user-agent, pixel ratio and font probe measurements. Cross-session evidence reuse is deferred until font-environment identity can be verified reliably; no cache hit or font fingerprint guarantee is claimed.

Details and executable evidence: [Browser layout inspection](P1.1-G-LAYOUT.md).

### Quality and cost evidence

Record model-check time, browser-measurement time, encoded preview frames, visual-model calls, seeded defects detected/missed and resulting repairs. Establish a baseline before setting an efficiency target; do not infer savings percentages from one fixture.

Model/geometry checks do not prove text layout, arbitrary path extents, occlusion, final pixels, audio synchronization, scientific correctness or visual appeal. Claims and narration still need approved-source checks. Human visual review remains Gate Q; assistant preview inspection is recorded separately.

## P1.1-H integrated acceptance

Start from an empty project, discover tools, create content, save a snapshot, inspect, preview, edit selected text/position and animation, export, restart, restore and compare. Include failure/safe retry and plugin version switching, with a failed upgrade preserving the previous usable implementation.

The deterministic [creative-loop scenario](P1.1-CREATIVE-LOOP.md) covers this path through restore, including revision-conflict rejection, durable idempotent replay and real brief-plugin upgrades with failed-candidate preservation. It exports six MP4s and 18 previews with snapshot/revision/hash receipts and plugin-transition evidence. The application explicitly supplies the selected factories when reopening; exported version choices do not load code automatically.

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
