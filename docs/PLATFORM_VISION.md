# ScienceMotion AI — Platform Vision

Last updated: 2026-11-13

## Product definition

ScienceMotion AI is a **professional creative framework and extensible tool platform for AI agents that create videos**.

The primary engineering objective is to build a platform skeleton capable of hosting hundreds of composable creative tools, multiple specialist engines, and iterative agent workflows. We are building infrastructure for AI creative agents—not a fixed-template video generator.

An agent should be able to discover available capabilities, understand their schemas, create a project and scene graph, combine tools freely, invoke specialist engines, preview results, inspect defects, revise selected elements, and render professional deliverables.

Templates and high-level workflows are useful accelerators, never the creative ceiling.

## What the platform provides

1. A canonical project/scene graph with versioned schemas and non-destructive editing.
2. A discoverable tool catalogue with typed manifests, namespaces, capabilities, examples, and versions.
3. A controlled tool gateway for validation, permissions, budgets, cancellation, retries, and execution traces.
4. A worker system that isolates rendering, simulation, audio, asset processing, and sandboxed code execution.
5. Engine adapters for Remotion, Three.js, Blender, Manim, FFmpeg, and future engines.
6. An asset/artifact system with stable references, hashes, provenance, licensing, and caching.
7. A visual feedback loop: preview → inspect → diagnose → patch → re-render.
8. A provider-independent agent orchestration layer that does not hard-code individual tools or engines.

## Agent creative workflow

1. Understand the brief, audience, format, quality bar, and constraints.
2. Discover tools by intent/capability and retrieve their schemas/examples.
3. Plan a project, scene graph, timeline, assets, and dependencies.
4. Compose low-level and high-level tools to create original visuals.
5. Dispatch specialist work to appropriate isolated workers/engines.
6. Preview frames/shots/sequences and inspect visual/audio diagnostics.
7. Patch selected nodes or shots while preserving approved content.
8. Render final outputs and persist manifests, traces, and artifacts.

The agent is a creative director and tool orchestrator. It is not restricted to a hard-coded scene catalogue.

## Tool domains

- Project, sequence, scene graph, timeline, layers, tracks, and revisions.
- 2D vector graphics, typography, diagrams, charts, masks, gradients, and motion design.
- Geometry, meshes, transforms, materials, textures, lights, cameras, rigs, and shaders.
- Animation, keyframes, easing, constraints, path motion, transitions, and retiming.
- Scientific visualization and simulation: equations, plots, particles, forces, waves, trajectories, rigid bodies, and selected fluid effects.
- Asset discovery, import, generation, transformation, metadata, provenance, and licensing.
- Narration, TTS, subtitles, music, sound effects, mixing, and audio QA.
- Compositing, color, effects, preview, rendering, inspection, comparison, and quality assurance.
- Specialist engine and sandboxed script/shader execution.

## Platform design requirements

Every tool must declare:
- Stable ID and semantic version.
- Name, purpose, description, examples, namespace, and category.
- Typed input/output schemas.
- Capabilities, engine/provider requirements, and compatibility.
- Determinism, statefulness, cost, destructive behavior, timeout, cancellation, and permissions.
- Output artifact types and diagnostics.

The registry must support dynamic discovery, search, version pinning, plugin lifecycle, and compatibility filtering. The gateway must validate and govern all execution. Workers must be isolated from the control plane and from one another.

The architecture should scale in stages: local modular runtime, single-host worker pools, then distributed workers and durable queues when required. Avoid premature microservices while preserving stable boundaries.

## Content and rendering decoupling

Editorial meaning, creative intent, project/scene graph, tool execution, assets, and render configuration are separate concerns. Renderers consume immutable project snapshots and never rewrite editorial content or call LLMs. The same project can be rendered by different engines through adapters.

## MVP strategy

Build the platform skeleton before attempting a huge catalogue:
1. Canonical project and scene graph.
2. Tool manifest, registry, discovery, and gateway.
3. Plugin/version/capability contracts.
4. Job envelopes, isolated workers, and artifact references.
5. Initial composable tools for project, geometry, 2D graphics, animation, timeline, assets, audio, preview, and inspection.
6. Agent preview/inspect/patch/re-render loop.
7. Specialist engines and deeper creative tools.

The first success criterion is not a fixed number of tools. It is proving that new tools and engines can be added through contracts without changing the agent orchestration core.

## Reference project

The CPU-cache explainer is the first end-to-end reference project and test fixture. It should exercise the same public project model and tools available to any agent. It is not the product's only use case or architecture boundary.
