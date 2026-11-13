# Architecture

## High-level pipeline

```text
Topic
  -> Research package (claims, sources, caveats)
  -> Script (narration + timing intent)
  -> Storyboard (ordered shots + durations)
  -> Scene specification (typed, validated props)
  -> Renderer (Remotion compositions)
  -> Audio/subtitle composition
  -> MP4 + quality report
```

## Initial repository boundaries

- `apps/studio`: future authoring/review UI. Keep the initial Remotion entry point lightweight until the engine is proven.
- `packages/video-engine`: composition registration, timing helpers, render presets, shared types.
- `packages/animation-2d`: reusable SVG/React motion graphics.
- `packages/animation-3d`: Three.js scene wrappers and camera utilities.
- `packages/scene-library`: reusable scene templates for common explanatory patterns.
- `packages/ai-director`: provider-independent schemas and orchestration for research/script/storyboard generation.
- `services/voice`: TTS adapters and audio alignment.
- `examples`: sample episodes and reproducible demos.
- `docs`: product, technical, and production decisions.

The first implementation intentionally keeps these boundaries as planned modules rather than creating empty packages prematurely. Extract modules when there is working functionality to own.

## Rendering model

Remotion evaluates a React composition at a specific frame. Animation values must be derived from the current frame and composition configuration, not wall-clock time. This makes output deterministic and allows the renderer to seek directly to any frame.

Default master format:
- 1920×1080
- 30 FPS
- H.264 MP4
- AAC audio when an audio track exists

Vertical and other platform formats should be composition presets, not separate implementations.

## Content model (planned)

A future episode should contain:
- metadata: title, language, target audience, aspect ratio, fps
- sources: URL, publisher, publication date, retrieval date
- claims: statement, supporting source IDs, confidence, caveats
- script segments: narration text, duration intent, claim references
- shots: scene type, duration, transition, typed props, narration segment IDs
- assets: licensed media, generated assets, attribution/license metadata

## Scientific correctness

Visuals must not silently imply measured or universal values. Label illustrative scales and simulations. Keep units explicit. For physical simulations, document assumptions, coordinate systems, and parameter ranges. For sourced factual statements, preserve source references through the script and shot data.
