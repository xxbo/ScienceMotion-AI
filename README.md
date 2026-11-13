# ScienceMotion AI

**A professional, extensible creative framework for AI agents that create videos.**

Our goal is to build a platform skeleton capable of hosting hundreds of composable creative tools and multiple specialist engines—not a fixed-template, one-click video generator.

AI agents should discover tools and schemas dynamically, construct project/scene graphs, combine 2D/3D/animation/simulation/audio capabilities, inspect previews, revise individual elements, and render professional outputs. Templates are optional accelerators, never the creative ceiling.

## Project status

- **P1.0 — Complete:** canonical Project Graph v1.1, patch/revision operations, prefab instantiation, animation/constraint data, migration, filesystem snapshots, validation, and automated tests.
- **P1.1 — Next:** dynamic tool discovery, registry/gateway hardening, namespaces, versioning, and plugin lifecycle.
- **P1.2 — Planned:** isolated workers, job execution, cancellation, progress, and resource governance.
- **P0 media polish — Non-blocking:** core Remotion/TTS/MP4 CI path works; speech-aligned captions, richer audio mixing, a polished long-form reference episode, proxy rendering, and formal render manifests remain enhancements.

P1.0 acceptance evidence: [GitHub Actions #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025).

## Platform foundations

- **Canonical project model:** versioned project, scene graph, timeline, assets, and non-destructive revisions.
- **Agent tool platform:** discoverable manifests, registry, gateway, plugins, permissions, and execution traces.
- **Worker execution:** isolated render, simulation, asset, audio, and sandbox workers.
- **Specialist engines:** Remotion, Three.js, Blender, Manim, FFmpeg, and future adapters.
- **Visual feedback:** preview → inspect → diagnose → patch → re-render.
- **Reproducibility:** stable IDs, schema versions, artifact hashes, provenance, and render manifests.

## Existing foundations

- Remotion-based 1080p render pipeline and Chinese CPU-cache reference episode.
- Renderer-neutral episode package and canonical Project Graph v1.1.
- Remotion episode-package consumer and independent SVG storyboard output.
- Renderer adapter interface.
- Tool manifest schema, registry/gateway contracts, and initial local runtime prototype.
- Mandarin TTS adapter and CI render workflow.

These foundations will be evolved incrementally; working components are reused rather than discarded.

## Roadmap

See [Platform Vision](docs/PLATFORM_VISION.md), [Development Plan](docs/PLAN.md), and [Architecture](docs/ARCHITECTURE.md). The immediate priority is P1.1: hardening the agent-facing tool platform on top of the completed Project Graph.
