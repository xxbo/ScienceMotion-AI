# Development Plan

Last updated: 2026-11-16

## Product goal and planning correction

Build ScienceMotion AI as an extensible science-video scaffold for AI agents: discover tools, compose original visuals, inspect previews, make targeted edits and render professional outputs. Preserve the ability to grow to hundreds of tools, while proving that those tools can actually create and modify video.

The 2026-11-14 review changes the next priority, not the technology direction: reuse the existing platform and connect a small real creative path before broadening management infrastructure. Content generation and rendering remain decoupled; the Project Graph remains the common creative model; templates remain optional.

[Platform Vision](PLATFORM_VISION.md) defines the product. [P1.1 Acceptance](P1.1-ACCEPTANCE.md) defines the exit gates. Status is evidence-based, not a percentage inferred from files or test counts.

## Verified baseline

Reviewed code baseline: `26f20bab6b56a6aa8774c80e5da25db84d00fefb`. [CI #43463301921](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43463301921) passed the existing 84 platform tests, type/schema checks, SVG storyboard, Remotion MP4 render, metadata/audio checks and artifact upload.

The F execution baseline `2566bd0de8b95b27a6adeeeb188c5d854f2b73e5` passed [CI #43612600513](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43612600513). It adds 25 focused reliability tests and three real Gateway/Repository integration tests. The next asset/workspace slice has its own tests and commit workflow, described in [P1.1-F Project/Artifact consistency](P1.1-F-PROJECT-ASSETS.md).

These baselines do not demonstrate generic Project Graph rendering, a real creative tool suite, autonomous visual inspection or the future acceptance gates below.

### P0 — Media foundation

Core Remotion 1080p rendering, Mandarin TTS, Episode validation, SVG storyboards and MP4 metadata/audio-stream checks work. The current CPU-cache render still uses the Episode package and topic-specific scene components.

Measured speech/caption alignment, music/SFX mixing and ducking, a polished 2–3 minute episode and advanced audiovisual quality work remain open. Minimal project-driven previews/export evidence move into P1.1-G; broad proxy-rendering optimization stays later.

### P1.0 — Accepted local project foundation

Historical acceptance: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025), commit `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`.

Delivered Project Schema v1.1.0, scene/node and timeline/asset models, prefab/constraint/dependency/animation data, validation, node Patch operations, revisions, local repository CAS, migration, hashing, snapshots and restore.

Acceptance means the local data/editing/snapshot baseline. Its original Patch contract provides add/update/remove/reparent node operations. F explicitly adds asset operations in Patch protocol 1.2.0 while preserving ProjectDocument 1.1.0 and legacy node patches. Other entity definitions do not imply equivalent editing APIs. Generic project rendering and a complete video-creation loop were not part of P1.0 acceptance.

## P1.1 — Tool platform: active, creative integration next

### Implemented slices retained

| Slice | Implemented local scope | Known boundary |
| --- | --- | --- |
| A: manifests/registry/plugins | Typed manifests, namespaces, discovery, paging, installation and lifecycle | Geometry JSON entries are catalogue fixtures; real creative implementations remain to be connected |
| B: execution governance | Validation, retries, concurrency and replay; F adds owned reservations, persistent local evidence and cancellation/policy hardening | Local guarantees only; first-host integration and external-effect reconciliation remain open |
| C: artifacts | SHA-256 IDs/URIs, memory/filesystem stores, metadata, deduplication and integrity checks | Shared-storage guarantees are later work |
| D: artifact lifecycle | Persistent references and local collection protection; F adds revisioned asset edits, workspace recovery and retained-snapshot pins | Protection requires the documented local host composition; broad retention/distribution remains deferred |
| E: plugin versions | Multi-version installation, one active version, pins/locks, guarded switching/rollback, dependency and compatibility checks | Automatic solving, marketplace/distribution and multi-plugin upgrade transactions are deferred |

P1.1-D baseline: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507). P1.1-E implementation boundaries are in [P1.1-E.md](P1.1-E.md); its full baseline CI is recorded above. Keep these delivered capabilities; expand them only when the creative acceptance path requires it.

### P1.1-F — Bounded reliability and editing integration (accepted local baseline)

Execution reliability is described in [P1.1-F.md](P1.1-F.md). The second local slice is in [P1.1-F-PROJECT-ASSETS.md](P1.1-F-PROJECT-ASSETS.md), including publication/recovery ordering, ownership, protocol compatibility and failure tests. The complete local host composition and Patch 1.3 schema passed [CI #43783296488](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43783296488), including 170 platform tests, schema validation and the legacy video render. This closes the F implementation/CI gate for the trusted single-writer local host; it does not claim distributed transactions or third-party sandboxing.

- [x] Atomically reserve idempotency identity and check input hashes for both pending and completed calls; cover concurrent same-key/different-input requests and rejection cleanup.
- [x] Persist local execution evidence, distinguish cancellation/timeout/failure outcomes and verify execution-store restart behavior. Interrupted/uncertain work is retained for explicit reconciliation, not silently replayed as success or blindly re-executed.
- [x] Test pre-start/admission/in-flight cancellation, non-cooperative timeout capacity retention, terminal-write failures and graceful admission stop/drain.
- [x] Add the bounded local workspace intent/pin/publish/reconcile protocol for canonical project revisions and retained snapshots; verify old/new authoritative heads after injected publication/cleanup failures.
- [x] Reject removal of assets used by clips/dependencies/component asset references. Protect retained-snapshot dependencies across live asset removal, GC and reopen/restore; no automatic cascade.
- [x] Repair changed-content references using both asset role and artifact identity. Reject URI/hash conflicts and verify bytes, preserving old evidence on missing/corrupt dependencies.
- [x] Add asset operations through Patch protocol 1.2.0 with schema compatibility checks; keep ProjectDocument 1.1.0 and old node patches working.
- [x] Add scene/shot/animation operations needed by the first tool set through the common revisioned editing boundary (Patch protocol 1.3.0; ProjectDocument remains 1.1.0).
- [x] Make animation semantics explicit: implement supported interpolation correctly and diagnose unsupported curves/easing rather than silently treating them as linear.
- [x] Compose the local creative host using the filesystem workspace, shared artifact lifecycle, persistent execution ledger, version-pinned plugins, Registry and Gateway. Bind sessions to one project and explicit tool/permission grants; enforce service-level authorization, byte/operation/concurrency/deadline limits, snapshot ownership and graceful drain.

Exit: focused failure/race/recovery tests pass and the creative host uses the tested local boundaries. No claim of a transaction spanning every external tool effect or distributed exactly-once execution. Detailed cases remain in Gate R; F is not a distributed database or plugin ecosystem project.

### P1.1-G — Executable tools and Project Snapshot rendering (active; snapshot render services CI-verified)

- [x] Add the first real tools for scene/shot creation, 2D text and shape creation, node transforms and keyframe editing through the scoped Plugin → Registry → Gateway boundary.
- [x] Add a deterministic Project Graph 2D render projection and Remotion composition for text, basic shapes, group transforms, opacity and supported keyframe sampling; keep the Episode renderer independent.
- [x] Add a water-cycle Project Graph fixture and CI MP4/ffprobe validation for the generic composition. Verified by [CI #43786811086](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43786811086): 175/175 platform tests passed, generic Project Graph MP4 passed 1080p/30fps/10s checks, and the legacy CPU-cache MP4/audio checks passed.
- [x] Add a structured SVG Path tool and Remotion path renderer. Path data is validated as SVG path commands only; raw SVG/XML markup is rejected. The tool writes a normal Project Graph path node through Patch 1.3.0.
- [x] Add a snapshot-bound Remotion render service for PNG frame previews and bounded MP4 frame ranges. Validate snapshot ownership/hash, frame bounds, byte limits and renderer output declarations; publish content-addressed Artifacts with revision/snapshot/renderer provenance.
- [x] Expose render.preview and render.video through the built-in plugin and Gateway, with explicit snapshot.read + artifact.write permissions. Return Artifact references to the AI caller. Verified by [CI #43788856539](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43788856539): 177/177 platform tests passed; production Creative Host rendered a PNG and a 3-second MP4 from a saved snapshot, and ffprobe verified the MP4 stream, 1080p, 30 FPS and duration. The existing Episode render/audio checks also passed.
- [ ] Expand the host render service with durable render-job progress/cancellation and richer evidence once worker isolation is introduced.
- [ ] Create two short, different-topic fixtures through public tool calls; do not add topic-specific TSX scenes. Demonstrate a targeted edit changes the intended rendered content while unrelated project state remains intact.
- [ ] Validate dynamic discovery/invocation with 300 synthetic manifests, separately from the executable-tool count. Test a new plugin tool without changing gateway/registry/orchestration core.

The generic Project Graph-to-renderer bridge and this small tool set are deliberately pulled forward from later integration/tool-family work. Reuse Remotion and keep the existing Episode demo as a regression fixture. No engine replacement or parallel project model is planned.

### P1.1-H — Creative-loop and extension acceptance

- [ ] Run a deterministic integration scenario: empty project → discovery → tool calls → project snapshot → preview → targeted revision → export → save/restart/restore, including failure/retry/version-switch paths.
- [ ] Run one real AI discovery-and-tool-use trial against the same host APIs, with recorded manifests, calls, revisions, diagnostics and artifacts; the model should not edit renderer source to complete the task.
- [ ] Review representative frames and timing from both short fixtures against content/legibility/layout expectations. Keep this separate from stream/codec metadata validation.
- [ ] Close P1.1 only on one exact commit with all acceptance gates and evidence recorded. Unverified gates stay open; a passing legacy demo does not close them.

### Deferred until after this creative loop

Plugin marketplace/distribution/signatures, automatic dependency solving, atomic multi-plugin upgrade plans, distributed idempotency/storage, remote object storage, elaborate retention scheduling and a full Studio UI. Necessary local integrity fixes remain in F; broad infrastructure work needs a demonstrated requirement.

## Later stages (preserved, boundaries clarified)

| Stage | Responsibility |
| --- | --- |
| P1.2 — Isolated execution | Job envelopes, single-host worker processes, progress/cancellation, failure isolation and enforceable CPU/memory/GPU/disk/network budgets; remote pools only when needed |
| P1.3 — Creative breadth | Expand the initial tools into coherent project/timeline, paths/SVG/charts, geometry, materials/cameras, animation, audio/captions and inspection families |
| P1.4 — Agent iteration | General provider-independent planning and autonomous preview/inspect/diagnose/patch loops, beyond the bounded P1.1 live-agent trial |
| P1.5 — Extension and scale | Real multi-tool composition, performance evidence and new engines without orchestration rewrites; synthetic catalogue tests are not a count of creative features |
| P2 — Professional depth | Advanced Remotion motion design, Three.js/Blender 3D, Manim mathematics, simulations, shaders, cinematography, color and audio |
| P3 — Providers/assets | Pluggable research/LLM/TTS/media providers, sources/claims, transformations, licensing and local-provider options |
| P4 — Production operations | Remote workers/storage, shared transactions, resumable jobs, incremental/batch exports, operational metrics and optional Studio UI |

## Engineering rules

Every new task identifies an acceptance gate or real creative operation it serves. Progress reports separate executable tools, catalogue fixtures, synthetic test entries, supported render features and visually reviewed outputs. Scope changes update Vision, Plan, Architecture and acceptance gates together.

Keep code, tests and scoped documentation in consolidated commits. Inspect the exact commit's CI and representative outputs before changing status. Preserve working foundations; defer speculative infrastructure; use the CPU-cache fixture and a second topic to prevent template lock-in.
