# Development Plan

Last updated: 2026-11-13

## Product goal

Build **ScienceMotion AI**, a professional, extensible creative framework designed for AI agents to create science explainers and other complex videos.

Our immediate goal is not to build a one-click video generator or hundreds of disconnected tools. It is to build a **platform skeleton capable of safely discovering, composing, executing, observing, and extending hundreds of creative tools**.

The agent should be able to work like a creative director and production team: understand a goal, discover relevant tools, create a project and scene graph, combine specialist capabilities, preview the result, inspect defects, revise specific parts, and render final deliverables.

Templates are optional accelerators. They must never define the creative ceiling. The CPU-cache episode remains our first reference project and integration fixture, not the product boundary.

## Non-negotiable principles

1. **Tool-first, agent-native:** the agent discovers tools and schemas dynamically; no hard-coded catalogue or fixed template workflow.
2. **Composable capability surface:** expose small, well-defined operations at both high and low levels, designed to combine into complex creative work.
3. **Content/render separation:** editorial meaning and renderer-neutral project data are independent from engine implementations.
4. **Engine independence:** Remotion, Three.js, Blender, Manim, and future engines connect through adapters and capability declarations.
5. **Preview and feedback loop:** preview → inspect → diagnose → patch → re-render is a first-class workflow.
6. **Non-destructive and reproducible:** stable IDs, versioned schemas, immutable snapshots, tool traces, asset hashes, and render manifests.
7. **Safe extensibility:** plugins and custom code run with explicit permissions, quotas, timeouts, and sandbox boundaries.
8. **Professional quality:** scientific accuracy, visual quality, audio quality, and rendering diagnostics must be testable.
9. **Scale by architecture, not premature infrastructure:** begin with clear modular boundaries and isolated workers; introduce distributed services when workload and operational needs justify them.

## Current baseline

- [x] Public repository, Remotion render pipeline, initial Chinese CPU-cache visual prototype.
- [x] Renderer-neutral episode JSON, JSON Schema, and TypeScript contract.
- [x] Remotion consumer reads scene order/type, captions, audio cues, and output profile from episode data.
- [x] Independent SVG storyboard output reads the same episode package.
- [x] Renderer adapter interface.
- [x] Tool manifest schema and TypeScript tool/registry/gateway contracts.
- [x] Initial in-memory registry and local schema-validating gateway prototype.
- [x] Platform vision and initial architecture for an agent-facing creative toolkit.
- [x] P1.0 local project/scene graph foundation, filesystem snapshots, patch/revision lifecycle, and validation suite (see P1.0 acceptance evidence below).
- [x] Full narration-enabled CI render and MP4 metadata/audio-track validation inspected.
- [ ] Production-grade Agent tool runtime, plugin lifecycle, isolated workers, and visual feedback loop (P1.1+).

## Roadmap

### P0 — Reliable media foundation

**Status: core rendering foundation verified; editorial/audio polish remains deferred and does not block P1.1.**

- [x] Establish repository, documentation, Remotion render, and CI.
- [x] Produce an initial 1080p 30 FPS Chinese CPU-cache visual prototype.
- [x] Add configurable Mandarin TTS adapter and audio track integration.
- [x] Verify narrated render in CI, including MP4 metadata and audio-stream presence.
- [ ] Align captions to measured speech timings and verify perceptual audio/video synchronization.
- [ ] Add music, ambience, SFX, fades, and narration ducking.
- [ ] Complete a polished 2–3 minute reference episode.
- [ ] Add preview/proxy rendering and a formal render manifest.

P0 is not claimed as a fully polished video-production experience. The verified baseline is sufficient to support platform development; remaining items are quality/product enhancements.

### P1 — Scalable platform skeleton (highest priority)

The exit goal is an extensible platform foundation that can host hundreds of tools without turning the agent, registry, or renderer into a monolith.

#### P1.0 — Canonical project model and scene graph

<badge color="success">Complete — accepted on 2026-11-13</badge>

Acceptance evidence: GitHub Actions run [#43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025), commit `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`, completed successfully. The run passed TypeScript checking, episode/project/patch schema validation, platform unit tests, SVG storyboard rendering, Mandarin TTS setup, Remotion MP4 rendering, MP4 metadata/audio validation, and artifact upload. The CPU-cache project fixture passed semantic project validation.

P1.0 scope is the local renderer-neutral project foundation. It does not claim a physical constraint solver, distributed database transactions, remote object storage, or a production multi-worker runtime; those belong to engine/worker/platform phases.
- [x] Define versioned Project, Sequence, Shot, Scene, Node, Track, Transform, Component, Asset, Clip, and Revision models in Project Schema v1.1.0.
- [x] Support stable IDs, parent/child relationships, scene roots, sequence-to-shot references, and component data.
- [x] Define coordinate-system, units, timebase, color-space, and asset URI fields.
- [x] Separate editorial reference, sequences, scenes, nodes, tracks, shots, assets, and revisions in the canonical project document.
- [x] Add schema validation and semantic reference/hierarchy validation for the CPU-cache project fixture.
- [x] Define versioned patch document schema and typed add/update/remove/reparent operations.
- [x] Implement atomic in-memory patch application with immutable source input, explicit recursive deletion, hierarchy checks, and base-revision conflict detection.
- [x] Add patch schema validation to CI.
- [x] Add explicit v1.0.0 → v1.1.0 project migration.
- [x] Add canonical JSON hashing and an in-memory immutable snapshot store with integrity verification and restore.
- [x] Add unit tests for add, reparent, recursive remove, stale revisions, cycle rejection, migration, and snapshot restore.
- [x] Add a durable filesystem snapshot backend with atomic temp-file/rename writes, listing, restore, and SHA-256 tamper detection.
- [x] Add property-based patch immutability checks (100 generated transform cases per test run).
- [x] Enforce scene ownership when adding/reparenting child nodes.
- [x] Strengthen project validation for unique scene roots and reciprocal parent/child references.
- [x] Add filesystem snapshot persistence with integrity checks; retain a persistence interface for future database/object-storage adapters.
- [x] Add reusable prefab subtree instantiation with stable ID remapping and source immutability.
- [x] Migrate CPU-cache reference project to all seven scenes/shots, audio clip/track linkage, a reusable memory prefab, and explicit dependency edges.
- [x] Add tests for cross-scene parenting rejection, prefab instantiation, prefab reference cleanup, and changed-parent reporting.
- [x] Clone prefab-internal animation tracks and remap their target node IDs.
- [x] Remove animation tracks when their target nodes are deleted.
- [x] Reject duplicate revision IDs and verify repository state matches the declared base revision.
- [x] Test prefab constraint/dependency/animation remapping, malformed prefab roots, ID collisions, and duplicate revision rejection.
- [x] Test project repository compare-and-swap conflicts and failed commit immutability.
- [x] Add property-based coverage for generated scene-root additions and hierarchy invariants.
- [x] Verify prefab cloning remaps internal node references while preserving external asset dependencies.
- [x] Verify repository patch → revision update → filesystem snapshot → restore as one end-to-end lifecycle.
- [x] Strengthen final graph validation for shot/sequence membership and duration bounds, clip ranges, prefab roots, constraint scene boundaries/parameters, and self-referencing dependency edges.
- [x] Add tests for cross-scene constraint rejection, current-schema migration idempotence, unknown schema rejection, and repository read isolation.
- [x] Complete final P1.0 acceptance: schema, migration, project validation, patch operations, animation, constraints, prefab, repository concurrency, filesystem snapshots, and CPU-cache fixture all pass the full CI workflow.
- [Deferred to P1.2/P4] Add database/object-storage snapshot adapter when durable multi-worker deployment is introduced.

#### P1.1 — Tool platform and extensibility

**Active phase.** Build on the completed P1.0 Project Graph and Patch APIs; do not create a parallel project model.
- [x] Define tool manifest schema and typed tool/registry/gateway contracts.
- [x] Implement initial in-memory registry and local schema-validating gateway prototype.
- [x] Define tool namespaces, categories, tags, capability requirements, engine bindings, project-schema compatibility, lifecycle, and semantic version policy in the manifest contract.
- [x] Implement dynamic registry discovery/search with namespace/category/tag/capability/engine/schema filters, pagination, deprecation filtering, and manifest retrieval.
- [x] Implement cooperative caller cancellation and timeout signaling in the local gateway; retain input/output validation, permission checks, and structured errors.
- [ ] Add idempotency keys, retry policy, per-tool concurrency limits, and durable execution records.
- [x] Add in-process plugin installation, enable/disable/uninstall, dependency/version checks, health checks, and rollback on failed registration or health validation.
- [x] Define plugin manifest schema, built-in geometry plugin manifest, and CI catalogue validation.
- [ ] Add plugin version pinning/upgrades, plugin compatibility checks, and dependency graph diagnostics.
- [ ] Persist tool-call records, input/output summaries, diagnostics, artifacts, and execution provenance.
- [ ] Add quotas, concurrency limits, resource budgets, and approval policies for expensive/destructive operations.
- [ ] Define stable artifact references and content-addressed asset storage.

#### P1.2 — Execution and worker architecture
- [ ] Keep the control plane responsible for project state, tool discovery, planning, authorization, and job orchestration.
- [ ] Define worker contracts for rendering, asset processing, simulation, audio, and sandboxed code execution.
- [ ] Add asynchronous jobs, queueing, cancellation, progress events, retry policy, and resumable execution.
- [ ] Isolate engine processes so a renderer crash cannot take down the agent/control plane.
- [ ] Add sandbox profiles with filesystem, network, CPU, memory, GPU, and time limits.
- [ ] Start with a modular monolith plus isolated workers; split into distributed services only when justified by scale.

#### P1.3 — Initial creative tool families
- [ ] Project/sequence/shot/scene/node/layer CRUD and patch tools.
- [ ] Geometry and transforms: primitives, paths, meshes, groups, parenting, coordinate transforms.
- [ ] 2D graphics: text, SVG, shapes, gradients, masks, arrows, labels, diagrams, and charts.
- [ ] Animation: keyframes, easing, interpolation, paths, constraints, transitions, and retiming.
- [ ] Timeline: tracks, clips, markers, duration, synchronization, and nested compositions.
- [ ] Asset operations: import, inspect, search, reference, transform, provenance, and license metadata.
- [ ] Audio: TTS, narration, captions, music/SFX placement, fades, mixing, and ducking.
- [ ] Preview/inspection: render still, frame range, shot proxy, inspect image/metadata, compare versions, and diagnostics.

#### P1.4 — Agent iteration and visual feedback
- [ ] Let the agent search tools by intent/capability and retrieve exact schemas/examples before invocation.
- [ ] Provide a production plan and execution graph with dependencies and checkpoints.
- [ ] Implement preview → inspect → diagnose → patch → re-render loop.
- [ ] Support shot/object-level revisions without invalidating unrelated approved work.
- [ ] Persist revisions, tool traces, artifact links, and render manifests.
- [ ] Add human approval gates for script, storyboard, assets, and final render.

#### P1.5 — Prove the skeleton scales
- [ ] Register and discover a representative catalogue across multiple namespaces and engine providers.
- [ ] Demonstrate composition of many small tools into a non-trivial video scene and sequence.
- [ ] Add contract tests for plugin compatibility, versioning, failure isolation, cancellation, and permissions.
- [ ] Demonstrate a renderer/provider can be added without changing the agent orchestration core.
- [ ] Demonstrate a tool can be added without changing the registry or agent core.
- [ ] Prove project snapshots remain renderer-neutral and unchanged by render operations.

**P1 exit criteria:** the platform has a stable project/scene graph, scalable tool registry/gateway, plugin contract, isolated worker execution model, artifact/provenance model, and visual iteration loop. A new tool or engine can be added through a declared contract rather than bespoke changes to the agent core.

### P2 — Professional creative engines and tool depth

- [ ] Remotion 2D motion design: compositing, typography, diagrams, masks, transitions, effects.
- [ ] Three.js: procedural geometry, imported models, PBR materials, lights, cameras, rigs, depth of field, post-processing.
- [ ] Blender worker/adapter: high-fidelity 3D, procedural geometry nodes, animation, rendering, compositing.
- [ ] Manim adapter: equations, plots, geometry, and mathematical derivations.
- [ ] Scientific simulation tools: particles, forces, springs, waves, trajectories, rigid bodies, selected fluid effects.
- [ ] Shader and custom procedural toolkits with safe sandboxing.
- [ ] Advanced audio/video compositing, color, and camera language.
- [ ] Capability negotiation and explicit fallbacks for unsupported engine features.

**Exit criteria:** agents can combine multiple professional engines and tool families to create original complex scenes, not just template-based slides.

### P3 — Generative providers and asset intelligence

- [ ] Pluggable LLM/research providers with structured outputs and source tracking.
- [ ] Pluggable image/video/audio/3D asset search, generation, and transformation providers.
- [ ] Asset segmentation, background removal, texture generation, model optimization, and caching.
- [ ] Pluggable TTS/voice providers and measured speech alignment.
- [ ] Asset provenance, licensing, attribution, hashes, and version tracking.
- [ ] Optional local model and local rendering integrations.

### P4 — Production operations and distribution

- [ ] Render workers/farm, queue scheduling, resumable jobs, caching, and incremental rendering.
- [ ] Automated visual/audio QA and configurable quality gates.
- [ ] Project snapshots, version comparison, rollback, and reproducibility manifests.
- [ ] Batch generation and platform-specific aspect ratio/export presets.
- [ ] Optional Studio UI for project graph, timeline, tool-call trace, asset manager, and review.
- [ ] Operational metrics, observability, usage accounting, and multi-project isolation.

## Tool catalogue strategy

The goal is not merely to accumulate a large number of endpoints. Tools must be coherent, discoverable, composable, versioned, and safe.

Initial namespaces:
- `project.*`: project, sequence, shot, scene, node, layer, track, timeline.
- `graphics.2d.*`: text, shape, path, SVG, mask, gradient, chart, diagram.
- `geometry.*`: primitive, mesh, transform, group, parent, coordinate conversion.
- `animation.*`: keyframe, easing, path, interpolation, transition, constraint.
- `camera.*`: camera creation, framing, lens, motion, depth of field.
- `lighting.*`: light, environment, shadow, exposure.
- `materials.*`: material, texture, shader, PBR properties.
- `simulation.*`: particle, force, spring, wave, rigid body, trajectory.
- `assets.*`: search, import, inspect, transform, provenance, licensing.
- `audio.*`: TTS, narration, caption, music, SFX, mix, ducking.
- `compositing.*`: layer, blend, mask, key, grade, effect.
- `render.*`: preview, still, proxy, final, cancel, status, manifest.
- `inspect.*`: frame, metadata, visual QA, audio QA, compare, diagnostics.
- `engine.<provider>.*`: explicitly engine-specific advanced capabilities.

Every tool declares stable ID/version, description, typed schemas, capabilities, engine requirements, determinism/statefulness, cost, permissions, timeout, cancellation behavior, and output artifacts.

## First reference project: CPU cache

Use the CPU-cache episode as the first project fixture:
- Migrate it toward the canonical project/scene graph.
- Build it using the same public tool APIs available to any agent.
- Demonstrate 2D diagrams, data flow, typography, 3D elements, narration, captions, and sound.
- Do not grant it privileged hard-coded shortcuts unavailable to other projects.

## Engineering workflow

- Keep `main` releasable and CI-validated.
- Keep schemas and tool contracts versioned and backward-compatible.
- Keep project model, tool runtime, providers, workers, and render adapters behind explicit boundaries.
- Prefer composable tools and structured results over a monolithic generate-video endpoint.
- Preserve reproducibility and inspectability for every tool call and render.
- Add tests and inspect representative artifacts before marking work complete.
