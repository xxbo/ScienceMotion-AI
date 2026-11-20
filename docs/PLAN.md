# Development Plan

Last updated 2026-11-20

## Goal and current priority

Build an extensible science-video framework for AI agents: discover typed tools, compose original visuals, inspect results, make targeted edits and export reproducible videos. Content meaning stays upstream; Project Graph remains the single creative model; templates are optional.

Prioritize a small demonstrated creation-and-repair workflow on Remotion. Programs should perform structural, temporal and geometry checks and return evidence to the AI. The AI uses node identities and diagnostics to choose edits. Representative rendered frames, media validation and human review remain necessary for final-output correctness and presentation quality.

[Platform Vision](PLATFORM_VISION.md) owns durable principles, [Architecture](ARCHITECTURE.md) implementation boundaries, and [P1.1 Acceptance](P1.1-ACCEPTANCE.md) measurable exit gates. Test counts and catalogue size are not product-completion percentages.

P1.2 delivers isolated local jobs with resource limits and measured bundle reuse. P1.3-A–C deliver PNG import, timeline editing and edits to existing 2D graphics with rendered evidence. P1.3-D covers keyframe editing and an initial transition. Human effect review is assigned to the final acceptance workstream. [P1.2 plan](P1.2-PLAN.md) · [P1.3 plan](P1.3-PLAN.md).

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
| P1.1-H AI acceptance | Local JSON-lines interface, recorded interactive Codex trial, separate CI replay, two-topic regression and persisted evidence | Final human visual review; general autonomous planning remains P1.4 |
| P1.2-A | Opt-in Linux render/layout processes, guardian cleanup of detached descendants, cancellation/deadlines, progress callbacks and bounded output/admission | C: scheduling/retention; D: aggregate budgets; E: measured performance/reuse |
| P1.2-B1 | Internal job contract and local durable ledger; project-scoped idempotency, owned state transitions, bounded progress/results and interruption on reopen | Reconciliation/retention administration in C |
| P1.2-B2 | Authorized host/client background jobs, retained input admission, bounded single runner and progress, stop/publication ordering, verified results and explicit revoke/close | D aggregate budgets and E performance |
| P1.2-B3 | Real protocol-1.1 cancellation, process/temp cleanup, PNG/MP4 receipts, exact reopened records and explicit verified-owner interrupted-host recovery | D aggregate budgets and E performance |
| P1.2-C1 | Independent waiting/execution limits, project round-robin/FIFO dispatch, multi-executor lifecycle/failure handling and actual simultaneous workers | D aggregate quotas |
| P1.2-C2 | Trusted retention inspection, durable reconciliation, job-specific output ownership, release and pruning | D aggregate quotas |
| P1.2-C3 | Real-worker concurrent edit, project isolation, scoped GC, plugin and shutdown behavior with a full queue, and durable restart records | D aggregate quotas |

The built-in workspace catalogue has 23 executable tools including inspection and workspace operations. The two-topic scenario adds one executable test extension using public services. The catalogue also has one JSON catalogue-only manifest and 300 synthetic scale entries (100 IDs × 3 versions). Plugin administration is available through the trusted application API. [PNG import](P1.3-PLAN.md#a--approved-png-imports) · [Timeline editing](P1.3-PLAN.md#b--timeline-editing) · [2D graphics editing](P1.3-PLAN.md#c--edit-existing-2d-graphics).

## Next delivery sequence

Current checkpoint decision (2026-11-17): the user explicitly instructed “验收留到最后进行吧，会有一个验收专项” and asked to proceed with P1.2. Move human effect review to the final acceptance workstream and proceed with the [five-step P1.2 sequence](P1.2-PLAN.md). The [review record](P1.1-REVIEW.md) retains the earlier AI sample feedback separately. Keep the [30-second CPU-cache sample](showcase/README.md) and [12-second AI trial](P1.1-AI-TRIAL.md) as comparison references. Automated checks remain required for every increment.

P1.1's engineering gates have evidence; full visual closure is deferred to the final acceptance workstream. I1, bounded I2 measurement, the [two-topic workflow](P1.1-CREATIVE-LOOP.md), [host plugin switching and catalogue scale](P1.1-PLUGIN-SWITCH-SCALE.md), and the [local AI interface and trial](P1.1-AI-TRIAL.md) are implemented. The [acceptance checklist](P1.1-ACCEPTANCE.md) retains 23/25 closed items under its existing wording: R 6/6, I 4/5, C 5/5, Q 2/3, X 3/3 and A 3/3. Its two human-review items are deferred, not current engineering blockers or evidence of completed visual review. These counts are not effort percentages.

| Order | Increment | Completion evidence |
| --- | --- | --- |
| 1 — implemented | Inspection I1: expose model checks through the public host | Typed report; permission/hash/frame/work limits; repair/recheck/restart scenario with zero render/vision calls |
| 2 — implemented | Inspection I2: measure actual browser layout | Font-ready line/element boxes; scoped reports; seeded text/motion/font cases; repair/recheck/restart and production-pixel correspondence |
| 3 — implemented | Two-topic creation and restoration | Two 12-second briefs use the same public tools/renderer; inspect/repair, text/motion edits, preview/export, failed mutation/idempotent retry, restart and restore with real data dependencies |
| 4 — implemented | Integrated extension/version and scale acceptance | Public host administration pauses/drains calls, switches exact versions and preserves the old version on failed upgrade; both topics continue editing; 300 synthetic manifests and timings recorded |
| 5 — implemented | Real-AI trial | Local stdio interface; interactive Codex discovery/create/inspect/repair/export trial with 50 tool calls, recorded snapshots/media/provenance; separate 52-request deterministic CI replay alongside existing regression |
| 6 — implemented | P1.2-A disposable render workers | Opt-in host/stdio worker mode; real CLI replay; mid-render cancellation with Chromium/FFmpeg reaped; no late Artifact; a new preview succeeds |
| 7a — implemented foundation | P1.2-B1 job contract and ledger | Eighteen tests of idempotency, state/publication/stop races, bounded progress, durable output, process abandonment and storage faults; no async client API yet |
| 7b — implemented | P1.2-B2 host/client job APIs | Seventeen tests of authorized submit/get/list/cancel, bounded admission, retained inputs, revoke/close, publication races and uncertainty; actual PNG/MP4 host-API smoke and persisted results after reopen |
| 7c — implemented | P1.2-B3 real worker/CLI interruption evidence | New protocol's mid-render cancellation, cleanup/no late result, subsequent success and verified-owner recovery after host interruption |
| 8a — implemented | P1.2-C1 scheduling core | Independent queue/execution limits, project round-robin/FIFO, cancellation/publication/failure ownership, complete close/plugin drain and real simultaneous workers with verified media |
| 8b — implemented | P1.2-C2 retention/reconciliation administration | Trusted inspection, explicit reconciliation and release/pruning with durable evidence and GC protection |
| 8c — implemented | P1.2-C3 concurrent editing/maintenance acceptance | Actual old/new snapshot rendering, retained-input GC protection, queue-pressure/lifecycle stress and restart evidence |
| 9a — implemented | P1.2-D1 budget contract and capability | Typed failure at startup for unavailable enforcement, delegated CPU and memory controls, and bounded disk capacity verified by CI |
| 9b — implemented | P1.2-D2 process-tree CPU and memory | CPU bandwidth and cumulative limits, charged memory ceiling, typed failure and cleanup |
| 9c — implemented | P1.2-D3 temporary disk | Leased, bounded temporary volumes, kernel exhaustion evidence, reclamation and real rendering |
| 9d — implemented | P1.2-D4 combined real-worker acceptance | Distinct resource failures, parallel healthy work and admission recovery with all budgets configured |
| 10a — implemented | P1.2-E1 performance baseline | Paired measurements of both execution modes with verified media, layout, cancellation and recovery |
| 10b — implemented | P1.2-E2 prepared bundle reuse | Paired performance gains with preparation included, verified invalidation, temporary-disk accounting, cancellation and snapshot isolation |
| 11a — implemented | P1.3-A approved PNG assets | Public import and placement, independent preview/video outputs, old and new snapshot recovery, and disk-budgeted worker evidence |
| 11b — implemented | P1.3-B timeline editing | Shot move, reorder and trim, PNG clips on video tracks, and decoded MP4 cut and duration checks |
| 11c — implemented | P1.3-C geometry, SVG and chart editing | Revisioned edits to existing nodes, localized pixel differences, verified export and identical restored preview |
| 11d — next implementation | P1.3-D keyframes and an initial transition | Targeted keyframe edits, easing and rendered boundary checks |
| Final acceptance workstream — deferred | Consolidated human effect review | Review both P1.1 fixtures and representative later outputs, record defects/fixes and final reviewed main evidence |

Land each verified increment independently. I2 is a bounded measurement feature, not a new Studio UI or a general autonomous video critic. Additional infrastructure needs an acceptance case that depends on it.

## Final human acceptance workstream

The user has reserved human effect review for the end. This workstream owns the two remaining P1.1 I/Q items, review of representative later outputs, and narration/caption alignment where present. Inspect approved content, text legibility, clipping, accidental overlap and motion timing; preserve baseline/edited/restored comparisons and record any fixes. The final report identifies the reviewed outputs, main commit, CI evidence and outstanding limitations. Do not convert the deferred items into passed checks before that evidence exists.

Automated validation, fault tests, real-render regression and PR/main CI remain part of each engineering delivery. The deferral does not postpone those checks or block P1.2-B.

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

The [recorded AI trial](P1.1-AI-TRIAL.md) uses the current OpenAI Codex session, a reused approved brief and public tools. It preserves schemas, action summaries, calls, revisions, diagnostics, media and intervention scope. Exact model build/sampling/token usage are unavailable and explicitly null. A disclosed seeded text overflow was repaired using browser measurements; the original record is distinct from the later CI replay, which makes zero new model calls. General planning and autonomous visual critique remain P1.4.

## Retained reliability boundaries

Preserve owned idempotency reservations and input-hash matching, explicit uncertain outcomes, restart evidence, cooperative timeout/cancellation accounting, publication/recovery ordering, retained-snapshot asset protection, guarded plugin versions and session/plugin/tool grants.

Project/plugin operation remains trusted and single-writer. The [P1.2 first slice](P1.2-WORKERS.md) optionally moves rendering and layout measurement into disposable Linux processes. Its guardian terminates/reaps descendants, including Chromium's separate process group; cancelled results are checked before Artifact publication. Node heap, output and admission bounds do not establish aggregate CPU/RSS/disk quotas. Cross-process project transactions and third-party sandboxing remain later capabilities. Detailed storage evidence remains in [F execution](P1.1-F.md), [F project/assets](P1.1-F-PROJECT-ASSETS.md), [F host](P1.1-F-CREATIVE-HOST.md) and [E versions](P1.1-E.md).

## Later roadmap

| Stage | Responsibility |
| --- | --- |
| P1.2 | A–E implemented. [P1.2 plan](P1.2-PLAN.md) |
| P1.3 | A–C implement PNG assets, timeline editing and edits to existing geometry, SVG paths and charts. D covers animation, followed by audio/captions and inspection. [P1.3 plan](P1.3-PLAN.md) |
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
| P1.1 technical acceptance and AI trial | `d8745ce2988d475e2a43f975233254a02648aec6`, [CI #43995270980](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43995270980), 215 tests; subsequent sample feedback in [review record](P1.1-REVIEW.md) |
| P1.2-A render-worker lifecycle | `b4e5bc9fa47111ce8a8324f69b14559d25d4f1de`, [CI #44002989900](https://github.com/xxbo/ScienceMotion-AI/actions/runs/44002989900), 223 tests; real worker replay, cancellation/cleanup and recovery preview |
| P1.2-B1 durable job ledger | `82281fccd7a8e567a3546e6546f6455aaa3f68d3`, [PR #10](https://github.com/xxbo/ScienceMotion-AI/pull/10), [main CI #44033946604](https://github.com/xxbo/ScienceMotion-AI/actions/runs/44033946604), 241 tests and all existing real-render regression |
| P1.2-B2 host/client jobs | `878d432a5fe077e8f44289558186b61b4a01c6fc`, [PR #11](https://github.com/xxbo/ScienceMotion-AI/pull/11), [main CI #44042129281](https://github.com/xxbo/ScienceMotion-AI/actions/runs/44042129281), 258 tests; real background PNG/MP4 and exact reopened results |
| P1.2-B3 real CLI lifecycle | `54e514e7bdee89dfa4a6166e2423c7b5e674b20b`, [PR #12](https://github.com/xxbo/ScienceMotion-AI/pull/12), [main CI #44046936446](https://github.com/xxbo/ScienceMotion-AI/actions/runs/44046936446), 259 tests; actual cancellation, process/temp cleanup and explicit interrupted-host recovery without replay |
