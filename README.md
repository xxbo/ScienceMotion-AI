# ScienceMotion AI

**A professional, extensible creative framework for AI agents that create videos.**

Our primary goal is to build a platform skeleton capable of hosting hundreds of composable creative tools and multiple specialist engines—not a fixed-template, one-click video generator.

AI agents discover tools and schemas dynamically, construct project/scene graphs, compose 2D/3D/animation/simulation/audio capabilities, inspect previews, revise individual elements, and render professional outputs. Templates are optional accelerators, never the creative ceiling.

## Platform foundations

- **Canonical project model:** versioned project, scene graph, timeline, assets, and non-destructive revisions.
- **Agent tool platform:** discoverable manifests, registry, gateway, plugins, permissions, and execution traces.
- **Worker execution:** isolated render, simulation, asset, audio, and sandbox workers.
- **Specialist engines:** Remotion, Three.js, Blender, Manim, FFmpeg, and future adapters.
- **Visual feedback:** preview → inspect → diagnose → patch → re-render.
- **Reproducibility:** stable IDs, schema versions, artifact hashes, provenance, and render manifests.

## Planned tool domains

Project/scene graph · 2D motion design · geometry and 3D · cameras/lights/materials · animation · physics/scientific simulation · charts/equations · assets · audio · compositing · render/inspection/QA · sandboxed custom code and shaders.

## Existing foundations

- Remotion-based 1080p render pipeline and Chinese CPU-cache reference episode.
- Renderer-neutral episode JSON, schema, and TypeScript contract.
- Remotion episode-package consumer and independent SVG storyboard output.
- Initial renderer adapter interface.
- Tool manifest schema, registry/gateway contracts, and local registry prototype.
- Mandarin TTS adapter and CI render workflow.

These foundations will be evolved incrementally into the larger platform; working components will be reused rather than discarded.

## Roadmap

See [Platform Vision](docs/PLATFORM_VISION.md), [Development Plan](docs/PLAN.md), and [Architecture](docs/ARCHITECTURE.md). The immediate priority is the P1 platform skeleton: project/scene graph, scalable tool platform, worker execution, and the agent visual iteration loop.
