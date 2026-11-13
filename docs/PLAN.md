# Development Plan

Last updated: 2026-11-13

## Product goal

Build **ScienceMotion AI**, an extensible creative toolkit and execution framework for AI agents that create professional, complex, visually compelling videos.

The platform provides a broad catalog of composable tools. An agent should be able to discover capabilities, plan a production, create and manipulate scenes, combine 2D/3D/simulation/media/audio tools, render previews, inspect results, and iteratively refine the work. Templates are accelerators, never the creative ceiling.

The CPU-cache explainer is the first reference project and integration test—not the product's only use case.

## Non-negotiable architecture principles

### 1. Content and rendering are decoupled
- Editorial meaning (research, claims, sources, narration, captions, creative brief) is stored independently from rendering implementation.
- A versioned project/episode package is the stable interchange contract.
- Renderers consume approved project snapshots; they do not call LLMs or rewrite editorial content.
- The same project should be renderable through multiple engines/adapters.

### 2. The agent is a tool-using creative director
- The agent is not limited to fixed video templates or a hard-coded scene sequence.
- It discovers tools by task/capability, reads schemas/examples, composes calls, and uses structured outputs.
- Tools range from high-level actions (create a sequence, build a chart, create a camera shot) to low-level controls (geometry, paths, keyframes, shaders, materials, masks, compositing).
- High-level templates and workflows are optional shortcuts built on top of the same lower-level tools.

### 3. Iterative visual feedback is a first-class capability
- Preview a frame, scene, shot, or sequence.
- Inspect rendered frames and diagnostics.
- Compare versions and revise only affected objects/shots where possible.
- Keep execution history, tool inputs/outputs, asset references, and render manifests reproducible.

### 4. Extensible specialist engines
- Expose portable creative operations through stable tool contracts.
- Implement them through engine adapters such as Remotion, Three.js, Blender, Manim, and future engines.
- Engine-specific tools are allowed when explicitly namespaced and capability-gated.
- Advanced custom code/shaders/simulations run in a restricted, reproducible execution environment.

## Current baseline

- [x] Public GitHub repository initialized.
- [x] Remotion-based video render pipeline and initial Chinese CPU-cache visual sample.
- [x] Renderer-neutral episode JSON, JSON Schema, and TypeScript contract.
- [x] Remotion reads scene ordering, scene type, captions, audio cues, and output profile from episode data.
- [x] Independent SVG storyboard output consumes the same episode package.
- [x] Initial renderer adapter interface.
- [x] Initial agent tool manifest schema and TypeScript registry/gateway contracts.
- [ ] Latest narration-enabled CI run and MP4 audio validation fully inspected.
- [x] Implement an initial in-memory tool registry with search/list/version lookup.
- [x] Implement a local invocation gateway with input/output schema validation, permission checks, timeouts, structured diagnostics, and execution lifecycle events.
- [ ] Add cancellation propagation, persistent execution history, artifact storage, and plugin discovery.
- [ ] Full project/scene graph model implemented.

## Roadmap

### P0 — Reliable media/render foundation
- [x] Initialize repository, documentation, Remotion render, and CI.
- [x] Produce a 1080p 30 FPS Chinese CPU-cache visual prototype.
- [x] Add configurable Mandarin TTS adapter and integrate an audio track.
- [ ] Verify the current narration-enabled render in CI, including audio metadata and sampled audio/video sync.
- [ ] Align captions to measured speech timings; support word/phrase-level captions.
- [ ] Add music, ambience, SFX, fades, and narration ducking.
- [ ] Complete the first polished 2–3 minute reference video.
- [ ] Add preview/proxy rendering and render-manifest reporting.

**Exit criteria:** reliable repeatable render, inspected audio/video, captions, render diagnostics, and a complete reference episode.

### P1 — Agent platform spine

#### P1.0 Project and scene graph
- [ ] Define versioned project, sequence, shot, scene, node, layer, transform, keyframe, asset, and dependency schemas.
- [ ] Support stable IDs, parent/child relationships, references, and non-destructive patches.
- [ ] Define coordinate systems, units, time bases, color spaces, and asset URI rules.
- [ ] Add migrations and compatibility tests.

#### P1.1 Tool registry and gateway
- [x] Define tool manifest schema with typed input/output contracts and execution metadata.
- [x] Define TypeScript contracts for tool manifests, registry, gateway, and results.
- [ ] Implement tool discovery/search and schema retrieval.
- [ ] Implement invocation gateway with schema validation, permissions, timeouts, cancellation, execution logs, and artifact persistence.
- [ ] Support tool versions, capability discovery, namespaces, and plugin registration.
- [ ] Add tool examples and machine-readable usage documentation.

#### P1.2 Initial creative toolset
- [ ] Project tools: create/open project, sequence, shot, scene, layer, group, and timeline operations.
- [ ] 2D tools: text, shape, path, SVG, masks, gradients, arrows, labels, charts, diagrams, and layout.
- [ ] Animation tools: keyframes, easing, path motion, transforms, morphing, timing, and transitions.
- [ ] Asset tools: import, search, inspect, transform, provenance, and license metadata.
- [ ] Audio tools: narration, TTS, captions, music/SFX placement, fades, mixing, and ducking.
- [ ] Preview tools: render still/frame range/shot proxy, inspect frame, retrieve diagnostics, and compare versions.

#### P1.3 Agent iteration loop
- [ ] Define a structured creative brief and agent production plan.
- [ ] Allow the agent to discover and combine tools dynamically instead of following a fixed template.
- [ ] Add preview → inspect → diagnose → patch → re-render loops.
- [ ] Add shot-level regeneration while preserving approved unrelated content.
- [ ] Add a human approval/review surface and checkpoints.
- [ ] Persist tool-call graph, decisions, outputs, and project revisions.

#### P1.4 Prove platform openness
- [ ] Build one reference video using low-level tool calls rather than a monolithic template.
- [ ] Build a second distinct visual style from the same semantic content.
- [ ] Prove tool extensions can be registered without changing the agent orchestration core.
- [ ] Verify the content package remains unchanged when renderers/themes are swapped.

**Exit criteria:** an agent can discover tools, construct a non-trivial scene/sequence, render a preview, inspect it, revise it, and produce a final output without being restricted to a predefined template.

### P2 — Professional visual and simulation capabilities

- [ ] Advanced 2D motion design: vector paths, masks, typography, kinetic type, graph/diagram layout, particles.
- [ ] Three.js 3D: procedural geometry, imported models, PBR materials, lights, cameras, rigging, depth of field, post-processing.
- [ ] Blender adapter for higher-fidelity 3D, compositing, and procedural scenes.
- [ ] Manim adapter for equations, plots, and mathematical derivations.
- [ ] Scientific simulation tools: particles, forces, springs, waves, trajectories, rigid-body and selected fluid effects.
- [ ] Data visualization tools with explicit units, scales, labels, and source bindings.
- [ ] Camera language, shot composition, color grading, transitions, and advanced compositing.
- [ ] Engine capability negotiation and graceful, explicit fallbacks.

**Exit criteria:** the agent can combine multiple specialist engines and tool families to create professional scenes beyond simple slide-like motion graphics.

### P3 — Asset intelligence and generative providers

- [ ] Pluggable image/video/audio/3D asset search and generation providers.
- [ ] Asset transformation, segmentation, background removal, texture generation, and model optimization.
- [ ] Asset provenance, licensing, attribution, content hashes, and cache management.
- [ ] Pluggable LLM/research providers with structured outputs and source tracking.
- [ ] Pluggable TTS/voice providers and speech alignment.
- [ ] Optional local model and local rendering integrations.

**Exit criteria:** providers can be swapped independently and agents can combine generated, sourced, and procedural assets with traceable rights/provenance.

### P4 — Production operations and distribution

- [ ] Render farm/worker queue, resumable jobs, caching, and incremental rendering.
- [ ] Resource budgets, execution sandboxing, quotas, and cancellation.
- [ ] Automated visual/audio QA and configurable quality gates.
- [ ] Version comparison, project snapshots, rollback, and reproducibility manifests.
- [ ] Batch generation, multiple aspect ratios, platform-specific exports, and delivery presets.
- [ ] Optional web studio for project inspection, tool-call trace, timeline, and review.

**Exit criteria:** reliable production workflows for multiple videos, projects, output profiles, and users.

## Tool domain inventory

The tool catalog should grow across:
1. Project/sequence/timeline/scene graph.
2. 2D graphics and motion design.
3. 3D geometry, materials, lights, cameras, and animation.
4. Physics and scientific simulation.
5. Charts, equations, diagrams, and data visualization.
6. Asset discovery, import, generation, and transformation.
7. Audio, narration, music, SFX, and captions.
8. Editing, compositing, color, and transitions.
9. Preview, render, frame inspection, diagnostics, and QA.
10. Specialist engine and sandboxed code/shader execution.

Every tool must declare stable ID/version, description, typed schemas, capabilities, engine requirements, determinism/statefulness, cost, permissions, timeout, and output artifacts.

## First reference project: CPU cache

Continue using the CPU-cache explainer to validate the platform:
- It should become a renderer-neutral project/scene graph.
- It should use the same public tool APIs available to any agent.
- It should demonstrate 2D diagrams, data flow, typography, camera/3D elements, narration, captions, and sound.
- It should not receive privileged hard-coded shortcuts unavailable to other projects.

## Engineering workflow

- Keep `main` releasable and CI-validated.
- Keep schemas/contracts versioned and backward-compatible.
- Keep content, tool orchestration, renderer adapters, and providers as separate dependency boundaries.
- Prefer small composable tools with structured results over one giant "generate video" tool.
- Preserve reproducibility and inspectability for every tool call and render.
- Do not mark work complete until code, tests, and representative outputs have been inspected.
