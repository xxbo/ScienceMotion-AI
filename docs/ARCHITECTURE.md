# Architecture

## Core architectural rule: content is not a renderer

ScienceMotion AI is designed around a strict boundary between **what the video says** and **how the video is drawn**.

Content generation produces an approved, versioned, renderer-neutral episode package. Rendering consumes that package and produces frames/audio/video. Neither side imports the implementation of the other.

### Ownership boundaries

| Concern | Content generation | Rendering |
|---|---|---|
| Research, claims, sources | Owns | Reads references for provenance only |
| Narration and editorial wording | Owns | Displays/plays supplied content |
| Shot order and semantic intent | Owns | Executes supplied order |
| Scene meaning and data | Owns typed scene intent | Maps intent to visual components |
| Layout, animation, camera, typography | No renderer-specific decisions | Owns |
| Frame rendering and encoding | No | Owns |
| TTS text and voice direction | Owns text/voice intent | Audio adapter synthesizes and mixes |
| LLM calls | Owns | Never |
| Renderer libraries | Never | Owns |

## Pipeline

```text
Topic
  -> Research package (claims, sources, caveats)
  -> Script (narration + timing intent)
  -> Storyboard (ordered shots + semantic scene intent)
  -> Versioned Episode Package (JSON + JSON Schema)
       |                    |                    |
       v                    v                    v
   Remotion 2D          Three.js 3D           Manim math
       |                    |                    |
       +--------------------+--------------------+
                            v
                 Audio/subtitle composition
                            v
                     MP4 + quality report
```

The content package is the stable interface. A renderer may implement only a subset of scene primitives; it must declare capabilities and either use a documented fallback or report an explicit unsupported feature. It must not silently alter scientific meaning.

## Episode package contract (planned)

The contract is versioned independently from application releases. Initial format: JSON, validated by JSON Schema and mirrored by TypeScript types.

Top-level fields:
- `schemaVersion`: explicit semantic contract version.
- `episode`: stable ID, title, language, audience, duration intent, and output profile intent.
- `sources`: stable source ID, URL, publisher, publication date, retrieval date, and attribution/license metadata.
- `claims`: stable claim ID, statement, supporting source IDs, confidence, caveats, and optional numeric values with units.
- `narration`: stable segment ID, text, voice direction, timing intent, and claim IDs.
- `shots`: stable shot ID, narration segment IDs, duration intent, transition intent, and ordered scene intents.
- `assets`: stable asset ID, URI or content hash, media type, license/attribution, and optional dimensions/duration.
- `audioCues`: stable cue ID, type, asset reference or generated voice segment, start/duration intent, gain, and ducking intent.
- `captions`: stable caption ID, narration segment reference, text, and optional measured start/end times.

Stable IDs allow a single shot or narration segment to be regenerated without invalidating unrelated approved work.

## Renderer adapter interface (planned)

A renderer adapter:
1. Declares its ID, version, supported schema versions, and scene primitive capabilities.
2. Validates package compatibility before rendering.
3. Maps scene intent to renderer-specific components.
4. Receives output settings separately from editorial content.
5. Emits a render manifest and structured diagnostics.
6. Never calls an LLM or edits the source episode package.

Candidate adapters:
- Remotion adapter: 2D motion graphics, titles, diagrams, subtitles, and compositing.
- Three.js adapter: spatial and 3D scenes.
- Manim adapter: equations, plots, and mathematical derivations.

The first implementation may render multiple scene types inside one Remotion adapter. The contract must remain renderer-neutral. The SVG storyboard script is an independent package consumer used to verify that episode content can produce a second visual artifact without loading Remotion; it is not yet a second MP4 renderer.

## Initial repository boundaries

- `apps/studio`: authoring and review UI. It should edit episode packages, not embed generation or rendering logic.
- `schemas/episode.schema.json` and `src/contracts/episode.ts`: versioned JSON Schema and TypeScript contract.
- `src/contracts/renderer.ts`: renderer adapter and capability contract.
- `episodes/`: renderer-neutral episode packages.
- `scripts/render-storyboard-svg.mjs`: first independent non-Remotion output adapter (SVG storyboard).
- `packages/ai-director`: provider-independent research/script/storyboard orchestration. It depends on episode-schema, not on renderers.
- `packages/renderer-core`: adapter interface, capability model, render manifest, and shared validation.
- `packages/renderer-remotion`: Remotion implementation and 2D scene components.
- `packages/renderer-three`: Three.js implementation.
- `packages/renderer-manim`: Manim process adapter and asset import.
- `packages/scene-library`: reusable renderer-neutral scene intents and templates.
- `services/voice`: replaceable TTS providers, speech metadata, and audio alignment.
- `examples`: source episode packages and reproducible render examples.
- `docs`: product, technical, and production decisions.

Extract modules incrementally when working functionality exists. Do not create empty package shells solely to imitate the target architecture.

## Dependency direction

Allowed:
- ai-director -> episode-schema
- studio -> episode-schema, ai-director API, renderer API
- renderer adapters -> episode-schema, renderer-core
- voice service -> narration/episode schema

Forbidden:
- ai-director -> Remotion, React rendering internals, Three.js, Manim, FFmpeg
- renderer adapters -> LLM providers or editorial generation
- episode-schema -> any provider or renderer package
- renderer adapter mutating approved source episode packages

## Rendering model

Remotion evaluates a React composition at a specific frame. Animation values must be derived from the current frame and composition configuration, not wall-clock time. This makes output deterministic and allows the renderer to seek directly to any frame.

Default master format:
- 1920×1080
- 30 FPS
- H.264 MP4
- AAC audio when an audio track exists

Vertical and other platform formats should be output profiles, not separate implementations or changes to editorial content.

## Scientific correctness

Visuals must not silently imply measured or universal values. Label illustrative scales and simulations. Keep units explicit. For physical simulations, document assumptions, coordinate systems, and parameter ranges. For sourced factual statements, preserve source references through claims, narration, and shot data. Rendering must preserve these references in its render manifest.

## Decoupling acceptance tests

- Validate an episode package without importing a rendering library or launching a browser.
- Render the same package using two renderer adapters or two independent visual themes.
- Assert that rendering does not mutate the package (content hash and semantic fields unchanged).
- Test schema-version compatibility and explicit failure for unsupported versions/features.
- Run AI-director unit tests in an environment without Remotion, Chromium, or FFmpeg.
