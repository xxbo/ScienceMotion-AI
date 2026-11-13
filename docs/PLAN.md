# Development Plan

Last updated: 2026-11-14

## Product goal

Build ScienceMotion AI: an extensible, professional science-video creation framework for AI agents. The immediate priority is a platform skeleton that can discover, compose, execute, observe and extend hundreds of tools. Tool count and a single polished demo are not substitutes for reliable contracts.

Templates are optional accelerators. Reuse the existing Remotion/TTS pipeline and CPU-cache reference project while growing independent editorial, project, tool, artifact and rendering layers.

## Non-negotiable principles

1. Content generation and animation/rendering remain decoupled. Renderers consume approved data, not language-model prompts that silently rewrite meaning.
2. All creative tools share the P1.0 Project Graph; avoid parallel project models.
3. Stable IDs, versioned schemas, explicit migrations, revision checks and reproducible artifacts underpin editing.
4. Agents discover typed tools dynamically and combine both low-level primitives and high-level helpers.
5. Preview, inspection and local revision are first-class goals.
6. Begin with a modular local control plane; introduce isolated workers and distributed storage as explicit later stages.
7. Distinguish implemented behavior, tested scope and planned capabilities. CI green does not prove untested concurrency, physical simulation or visual quality.

## P0 — Media foundation

Core Remotion 1080p rendering, Mandarin TTS, episode validation, SVG storyboards and MP4 metadata/audio-stream checks have passed CI.

Still open, non-blocking for tool-platform work: measured speech/caption alignment, perceptual audio/video review, music/SFX mixing and ducking, a polished 2–3 minute episode, proxy previews and formal render manifests.

## P1 — Scalable platform skeleton

### P1.0 — Canonical project foundation: accepted local baseline

Acceptance evidence: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025), commit `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`.

Delivered Project Schema v1.1.0 and types; scenes/nodes/transforms/components; sequences/shots/tracks/clips/assets; prefab/constraint/dependency/animation data; graph validation; non-destructive node patches and revisions; local repository CAS; schema migration; hashing, memory/filesystem snapshots and restore; CPU-cache project fixture and unit/property tests.

Accepted scope is a local data/editing foundation. Constraint solving, distributed transactions, remote object storage and generic Project Graph rendering are not implied. The existing video pipeline still renders the Episode package.

### P1.1 — Tool platform: active

| Slice | Implemented local scope | Remaining boundary |
| --- | --- | --- |
| A: manifests/registry/plugins | Namespaces, schemas, discovery filters, paging, version selection, install/enable/disable/uninstall, health checks | Package distribution, sandboxing and broader compatibility |
| B: execution governance | Input/output checks, configured permission checks, cooperative cancellation/timeouts, bounded retries, per-tool concurrency, in-memory execution records and result replay | Durable records, atomic concurrent idempotency reservation, budgets/approvals |
| C: artifacts | SHA-256 IDs/URIs, memory/filesystem stores, deduplication, read integrity and returned-reference checks | Shared-storage transactions and production retention |
| D: local artifact lifecycle | Persistent references, project links/unlinks, reconciliation, local manager serialization and age-based collection | Project/reference transaction integration, stale-reference repair edge cases and scheduled GC |
| E: plugin versions | Multi-version installation, one active version, pins/lock documents, guarded upgrade/downgrade/rollback, dependency diagnostics and schema compatibility | Automatic dependency solving, atomic multi-plugin upgrades and trusted package integrity |

P1.1-D baseline: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507), commit `64eb191e08d1b633b6ce69927cf631ea2a090161`.

P1.1-E implementation and test boundaries are in [P1.1-E.md](P1.1-E.md). Focused local checks have passed; full acceptance is tied to the workflow for the commit containing this update. P1.1 overall remains open.

Next work:
- [ ] Harden execution governance: atomic idempotency reservation/input matching, durable history, cancellation races and retention of execution evidence.
- [ ] Introduce explicit budgets, destructive-operation approvals and permission policy defaults.
- [ ] Implement real built-in project/geometry tools through the existing repository/Patch APIs. Current geometry JSON manifests are catalogue fixtures.
- [ ] Complete artifact/project transaction and reconciliation checks; preserve shared assets and snapshot references.
- [ ] Integrate plugin → discovery → gateway → project mutation/artifact → snapshot, with failure/retry and version-switch tests.
- [ ] Complete P1.1 acceptance on one exact commit and document remaining deployment boundaries.

### P1.2 — Isolated execution

Versioned job envelopes; render/simulation/audio/asset/sandbox worker contracts; durable queues; progress/cancellation; safe retries; failure isolation; CPU/memory/GPU/disk/network budgets. Start on one host before remote worker pools. Add shared persistence and cross-process transactions when introduced.

### P1.3 — Initial creative tool families

Project/scene/node/sequence/timeline operations; geometry/transforms; text/shapes/paths/SVG/masks/gradients/charts; animation/keyframes/easing; media imports and provenance; audio/captions/mixing; frame/shot previews and diagnostic inspection.

### P1.4 — Agent iteration

Dynamic tool discovery and schema reading; production plans and execution dependencies; preview → inspect → diagnose → patch → re-render; object/shot-level revision; human review gates; durable traces and render manifests.

### P1.5 — Extension and scale acceptance

Representative multi-namespace catalogue; composition of many small tools; plugin/version/failure/cancellation/permission contract tests; new tools and engines added without rewriting orchestration; immutable render snapshots and explicit unsupported-capability diagnostics.

## P2 — Professional engines and creative depth

Remotion motion design; Three.js geometry/materials/cameras/lights; Blender offline 3D and compositing; Manim equations/plots; scientific simulation; advanced shaders, cinematography, color and audio. Engines own specialist execution behind declared capability contracts.

## P3 — Providers and asset intelligence

Pluggable research/LLM/TTS and image/video/audio/model providers; source and claim tracking; asset transformations/segmentation/optimization; provenance/licenses/attribution; local-provider options and caching.

## P4 — Production operations

Remote workers/object storage, resumable jobs and incremental rendering, visual/audio quality gates, version comparison and reproducibility reports, batch/multi-format exports, optional Studio UI, operational metrics and multi-project isolation.

## Tool domains and engineering workflow

Grow coherent namespaces: `project.*`, `graphics.2d.*`, `geometry.*`, `animation.*`, `camera.*`, `lighting.*`, `materials.*`, `simulation.*`, `assets.*`, `audio.*`, `compositing.*`, `render.*`, `inspect.*`, and namespaced specialist `engine.<provider>.*` extensions.

The CPU-cache explainer remains the reference fixture, not a privileged template. Production capabilities should use the same public contracts as future agents and plugins.

Validate code and documentation before a consolidated commit. Preserve a readable README, a current architecture description and a separate plan; keep transient debugging history in Git history or focused acceptance notes. A phase closes on inspected evidence, not unchecked status-label edits.
