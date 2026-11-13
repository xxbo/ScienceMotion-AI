# Development Plan

Last updated: 2026-11-13

## Product goal

Build a reusable AI-assisted production system for accurate, visually compelling science and technology explainer videos. The workflow should accept a topic and produce a reviewed research package, script, storyboard, narration, renderer-neutral scene specification, and final MP4.

## Non-negotiable architecture principle: content generation and rendering are decoupled

This is a foundational requirement, not a later refactor.

- **Content generation owns meaning:** research, factual claims, sources, narration, timing intent, storyboard, and scene intent.
- **Rendering owns presentation:** layout, animation curves, typography, camera motion, frame rendering, audio mixing, and encoding.
- The boundary is a versioned, validated, renderer-neutral episode package (JSON first; typed TypeScript models and JSON Schema as the contract).
- The AI director must not directly import Remotion, React, Three.js, Manim, FFmpeg, or renderer implementation details.
- Renderers must not call LLMs or make editorial decisions. They consume approved episode packages and deterministic asset references.
- A single episode package should be renderable by different renderer adapters (e.g. Remotion 2D, Three.js 3D, Manim math scenes) without regenerating its research or script.
- Preserve stable IDs and explicit timing/units/source references across the pipeline. Validate package versions and reject unsupported schema versions clearly.
- Keep provider adapters replaceable: model provider, TTS provider, and renderer should be independently swappable.

**Architecture acceptance test:** take one approved episode package, render it through two renderer adapters or two visual themes, and prove that its research, narration, shot order, source references, and semantic scene data remain unchanged.

## Principles

1. Accuracy before visual spectacle: claims and numerical examples must be traceable.
2. Code-generated visuals for explainable systems: diagrams, timelines, formulas, mechanisms, and charts should be deterministic.
3. Reusable components: each scene should be independently testable and composable.
4. Separate content from presentation: structured episode data is the stable contract between generation and rendering.
5. Human approval gates: research, script, and storyboard must be reviewable before rendering.
6. Measure the actual pipeline: record render time, output size, frame rate, and quality issues.

## Milestones

### P0 — Video engine validation

- [x] Initialize repository and architecture documentation.
- [x] Add a Remotion composition and initial motion-graphics scenes.
- [ ] Install dependencies and verify the studio starts.
- [x] Render a 1920×1080, 30 FPS, 30-second Chinese MP4 sample in GitHub Actions.
- [x] Inspect representative frames for layout, clipping, typography, and timing.
- [x] Add a configurable Mandarin TTS adapter using Edge TTS with a replaceable provider boundary.
- [x] Add a narration track to the Remotion composition and extend the sample timeline.
- [ ] Verify the latest narrated render in CI, including audio stream metadata.
- [ ] Align subtitle boundaries to actual speech segments and add word-level captions.
- [ ] Add background music, sound-effect tracks, and narration ducking.
- [ ] Produce the first complete 2–3 minute CPU cache explainer.

**Exit criteria:** a reproducible command generates a complete MP4 from source with stable timing and no visual defects. The initial visual render is validated; the narrated render and full 2–3 minute episode remain open until CI output and audio are inspected.

### P1 — Renderer-neutral episode contract and AI director

**P1.0 — Define the boundary before expanding AI generation**
- [x] Define a versioned episode package schema and JSON Schema validation (schema v1.0.0).
- [x] Model metadata, source records, factual claims, narration segments, shot list, scene intents, asset references, caption timing, and audio cues.
- [x] Give every claim, narration segment, shot, scene, and asset a stable ID.
- [x] Create the CPU-cache episode as a renderer-neutral JSON package.
- [x] Refactor the Remotion composition to select scene adapters from package scene types and read captions/audio cues from package data.
- [x] Add schema and semantic cross-reference validation to CI.
- [ ] Define renderer-neutral scene primitives (text, shape, arrow, chart, timeline, equation, diagram, 3D asset reference) and explicit units/coordinate systems.
- [ ] Define renderer adapter interfaces, capability negotiation, unsupported-feature handling, and deterministic fallback behavior.
- [ ] Add golden fixture episodes and schema compatibility tests.

**P1.1 — Build content generation against the contract**
- [ ] Define provider-independent research, script, storyboard, and scene-intent interfaces.
- [ ] Generate source-backed claims and preserve citations through narration and shots.
- [ ] Generate an editable shot list from an approved script.
- [ ] Generate scene intent and typed props, never arbitrary renderer-specific application code as the default path.
- [ ] Add human review gates and per-shot regeneration without changing unrelated approved content.

**P1.2 — Prove true decoupling**
- [ ] Move the CPU cache episode into a renderer-neutral episode package.
- [ ] Refactor Remotion to consume that package through an adapter.
- [ ] Add a second minimal renderer adapter or theme consuming the exact same package.
- [ ] Compare package hashes/semantic fields before and after rendering to prove the content package is unchanged.
- [ ] Keep AI director tests runnable without browser or video-renderer dependencies.

**Exit criteria:** one approved, versioned episode package can be generated and reviewed without loading rendering libraries, then rendered by multiple adapters without changing its content, narration, citations, or shot order. Initial schema, sample package, validator, and first Remotion consumer are in place; the second renderer and content-only dependency isolation remain outstanding.

### P2 — Scientific visual toolkit

- [ ] Build 2D primitives: labels, callouts, arrows, charts, grids, timelines, equations.
- [ ] Add Three.js scene integration for 3D objects and camera motion behind a renderer adapter.
- [ ] Add optional Manim rendering/import behind a renderer adapter for mathematical scenes.
- [ ] Create reusable science/technology visual templates.
- [ ] Add unit-aware chart and diagram helpers.
- [ ] Add renderer capability declarations and fallbacks for unsupported scene primitives.

**Exit criteria:** common scientific and engineering concepts can be expressed in renderer-neutral scene data and rendered by the appropriate adapter.

### P3 — Production automation

- [ ] Integrate configurable TTS providers independently from the visual renderer.
- [ ] Generate word- or sentence-aligned subtitles from actual speech timing.
- [ ] Add music and sound-effect tracks with ducking.
- [ ] Build automated render and frame-sampling quality checks.
- [ ] Add batch rendering and resumable jobs.
- [ ] Export platform presets for landscape and vertical formats.
- [ ] Record reproducibility metadata: schema version, model/provider versions, renderer version, assets, and render settings.

**Exit criteria:** one approved episode package can flow through replaceable content, voice, and renderer providers to a publishable video with limited manual intervention.

## First episode: CPU cache

Working title: **Why Does a CPU Need Cache?**

Proposed narrative:
1. The CPU can execute instructions much faster than main memory can supply data.
2. Waiting for data creates a performance bottleneck.
3. Cache stores recently or frequently used data close to the CPU.
4. L1, L2, and L3 trade capacity for latency.
5. Cache hits avoid a trip to slower memory; cache misses do not.

Technical accuracy notes:
- Avoid presenting one universal latency number; values vary by processor, clock, cache level, and memory configuration.
- Explain locality (temporal and spatial) before implying cache contents are predictable.
- Distinguish cache capacity, latency, bandwidth, and hit rate.
- Clearly label illustrative diagrams and any non-measured timing examples.

## Engineering workflow

- Keep `main` releasable.
- Use short-lived feature branches for substantial changes.
- Add typecheck and render smoke tests before expanding the pipeline.
- Keep generation packages and renderer packages as separate dependency graphs.
- Do not claim a milestone is complete until the relevant command has run and output has been inspected.
