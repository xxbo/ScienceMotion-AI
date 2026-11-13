# ScienceMotion AI

**An extensible creative toolkit and execution framework for AI agents that create professional videos.**

ScienceMotion AI is not limited to one-click generation or fixed templates. It gives AI agents a growing catalog of composable creative tools for building scenes, animation, 2D/3D graphics, simulations, cinematography, audio, compositing, rendering, and iterative visual QA.

The agent acts as a creative director: it discovers tools, plans a production, composes tool calls, inspects previews, revises the project, and renders final outputs. Templates are optional accelerators—not the creative ceiling.

## Core architecture

- **Renderer-neutral project data:** versioned project/episode packages keep editorial meaning and scene intent independent of any rendering engine.
- **Agent tool system:** discoverable typed tools with schemas, capabilities, permissions, execution limits, structured results, and artifacts.
- **Specialist engine adapters:** Remotion, Three.js, Blender, Manim, and future engines can implement capabilities behind stable interfaces.
- **Visual feedback loop:** preview, inspect, diagnose, patch, and re-render.
- **Provider independence:** LLM, research, TTS, asset, and renderer providers can be swapped independently.

## Planned tool domains

Project/scene graph · 2D motion design · 3D geometry/materials/cameras · animation/keyframes · physics/scientific simulation · charts/equations · asset discovery/generation · audio/TTS/captions · compositing/color · preview/render/inspection/QA · sandboxed custom code and shaders.

## Current implementation

- Remotion-based 1080p video render pipeline.
- Chinese CPU-cache reference episode.
- Versioned episode JSON schema and TypeScript contract.
- Remotion episode-package consumer.
- Independent SVG storyboard renderer.
- Initial renderer adapter interface.
- Agent tool manifest schema and registry/gateway contracts.

The registry runtime, broad creative toolset, project scene graph, and iterative agent workflow are planned next. See [Platform Vision](docs/PLATFORM_VISION.md), [Development Plan](docs/PLAN.md), and [Architecture](docs/ARCHITECTURE.md).

## Quick start (current prototype)

Requirements: Node.js 20.19+ and Python 3.10+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-voice.txt
npm run validate:episode
npm run render:storyboard
npm run studio
```

The current Remotion prototype generates Mandarin narration through the configured Edge TTS adapter. The platform's general-purpose agent tool gateway and creative tool catalog are still under development.
