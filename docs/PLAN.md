# Development Plan

Last updated: 2026-11-14

## Product goal and planning correction

Build ScienceMotion AI as an extensible science-video scaffold for AI agents: discover tools, compose original visuals, inspect previews, make targeted edits and render professional outputs. Preserve the ability to grow to hundreds of tools, while proving that those tools can actually create and modify video.

The 2026-11-14 review changes the next priority, not the technology direction: reuse the existing platform and connect a small real creative path before broadening management infrastructure. Content generation and rendering remain decoupled; the Project Graph remains the common creative model; templates remain optional.

[Platform Vision](PLATFORM_VISION.md) defines the product. [P1.1 Acceptance](P1.1-ACCEPTANCE.md) defines the exit gates. Status is evidence-based, not a percentage inferred from files or test counts.

## Verified baseline

Reviewed code baseline: `26f20bab6b56a6aa8774c80e5da25db84d00fefb`. [CI #43463301921](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43463301921) passed the existing 84 platform tests, type/schema checks, SVG storyboard, Remotion MP4 render, metadata/audio checks and artifact upload.

This validates the implemented baseline. It does not demonstrate generic Project Graph rendering, a real creative tool suite, autonomous visual inspection or the future acceptance gates below. This planning update is documentation-only.

### P0 — Media foundation

Core Remotion 1080p rendering, Mandarin TTS, Episode validation, SVG storyboards and MP4 metadata/audio-stream checks work. The current CPU-cache render still uses the Episode package and topic-specific scene components.

Measured speech/caption alignment, music/SFX mixing and ducking, a polished 2–3 minute episode and advanced audiovisual quality work remain open. Minimal project-driven previews/export evidence move into P1.1-G; broad proxy-rendering optimization stays later.

### P1.0 — Accepted local project foundation

Historical acceptance: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025), commit `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`.

Delivered Project Schema v1.1.0, scene/node and timeline/asset models, prefab/constraint/dependency/animation data, validation, node Patch operations, revisions, local repository CAS, migration, hashing, snapshots and restore.

Acceptance means the local data/editing/snapshot baseline. The current Patch contract provides add/update/remove/reparent node operations; other entity data definitions do not imply equivalent transactional editing APIs. Generic project rendering and a complete video-creation loop were not part of this acceptance. Extend the model through explicit versioned operations/migrations only as real tools need them.

## P1.1 — Tool platform: active, creative integration next

### Implemented slices retained

| Slice | Implemented local scope | Known boundary |
| --- | --- | --- |
| A: manifests/registry/plugins | Typed manifests, namespaces, discovery, paging, installation and lifecycle | Geometry JSON entries are catalogue fixtures; real creative implementations remain to be connected |
| B: execution governance | Validation, configured permissions, cooperative cancellation/timeouts, retries, concurrency, in-memory records/replay | Atomic concurrent idempotency, cancellation races, durable evidence and explicit policy defaults need hardening |
| C: artifacts | SHA-256 IDs/URIs, memory/filesystem stores, metadata, deduplication and integrity checks | Shared-storage guarantees are later work |
| D: artifact lifecycle | Persistent references, project links/unlinks, reconciliation and manager-local collection protection | Project/reference commits, snapshot protection, asset-use checks and repair edge cases remain open |
| E: plugin versions | Multi-version installation, one active version, pins/locks, guarded switching/rollback, dependency and compatibility checks | Automatic solving, marketplace/distribution and multi-plugin upgrade transactions are deferred |

P1.1-D baseline: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507). P1.1-E implementation boundaries are in [P1.1-E.md](P1.1-E.md); its full baseline CI is recorded above. Keep these delivered capabilities; expand them only when the creative acceptance path requires it.

### P1.1-F — Bounded reliability and editing integration (next)

- [ ] Atomically reserve idempotency identity and check input hashes for both pending and completed calls; cover concurrent same-key/different-input requests and rejection cleanup.
- [ ] Persist local execution evidence, distinguish cancellation/timeout/failure outcomes and verify restart behavior. Interrupted/uncertain work must not be silently replayed as success or blindly re-executed.
- [ ] Coordinate project revisions with artifact references through a tested local commit/recovery protocol. Reject removal of assets still used by clips/dependencies unless an explicit valid cascade is requested; preserve assets required by retained snapshots.
- [ ] Repair stale references when an asset ID points to changed content; validate artifact URI/hash consistency and failure paths. Centralize destructive lifecycle access in the host composition.
- [ ] Add only the scene/animation/asset operations required by the first tool set through the common revisioned editing boundary, with explicit schema compatibility/migrations where needed.
- [ ] Make animation semantics explicit: implement supported interpolation correctly and diagnose unsupported curves/easing rather than silently treating them as linear.
- [ ] Configure explicit least-privilege permissions and bounded local call limits; require approval or disable destructive/high-cost paths in the first host. A general budget service is not a prerequisite.

Exit: focused failure/race/recovery tests pass; no silent duplicate mutation, loss of retained assets or false execution-success record in the tested local scope. Detailed cases: gate R in the acceptance document. Do not turn F into a distributed database or plugin ecosystem project.

### P1.1-G — Executable tools and Project Snapshot rendering

- [ ] Implement an initial set of roughly 10–12 real tools using Plugin → Registry → Gateway → the canonical repository/editing boundary. Proposed tool names and required behaviors are in the acceptance document.
- [ ] Add a generic 2D renderer adapter consuming immutable project snapshots: text, basic shapes, grouping, transforms, opacity and explicitly supported animation. Preserve approved editorial content; surface unsupported-capability diagnostics.
- [ ] Produce a frame/short-shot preview and a short final video as validated Artifacts. Record the project revision/snapshot hash, tool/plugin selections, render profile and output hashes.
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
