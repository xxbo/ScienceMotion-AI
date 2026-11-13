# Development Plan

Last updated: 2026-11-13

## Product goal

Build a reusable AI-assisted production system for accurate, visually compelling science and technology explainer videos. The workflow should eventually accept a topic and produce a reviewed script, storyboard, animation scenes, narration, captions, and final MP4.

## Principles

1. Accuracy before visual spectacle: claims and numerical examples must be traceable.
2. Code-generated visuals for explainable systems: diagrams, timelines, formulas, mechanisms, and charts should be deterministic.
3. Reusable components: each scene should be independently testable and composable.
4. Separate content from presentation: storyboards and scene specifications should be structured data.
5. Human approval gates: research, script, and storyboard must be reviewable before expensive rendering.
6. Measure the actual pipeline: record render time, output size, frame rate, and quality issues.

## Milestones

### P0 — Video engine validation

- [x] Initialize repository and architecture documentation.
- [x] Add a Remotion composition and initial motion-graphics scenes.
- [ ] Install dependencies and verify the studio starts.
- [x] Render a 1920×1080, 30 FPS, 30-second Chinese MP4 sample in GitHub Actions.
- [x] Inspect representative frames for layout, clipping, typography, and timing.
- [ ] Add a configurable Mandarin TTS adapter and mix narration with the subtitle timeline.
- [ ] Add voice-over, captions, and audio mixing.
- [ ] Produce the first complete 2–3 minute CPU cache explainer.

**Exit criteria:** a reproducible command generates a complete MP4 from source with stable timing and no visual defects. The render engine is validated with a 30-second silent/captioned prototype; narration, audio mixing, and the full 2–3 minute episode remain open.

### P1 — Structured AI director

- [ ] Define validated schemas for research notes, script, storyboard, and scene props.
- [ ] Generate a shot list from an approved script.
- [ ] Map shot types to reusable scene templates.
- [ ] Generate scene data rather than arbitrary application code wherever possible.
- [ ] Add citation/source metadata to factual claims.
- [ ] Add a review-and-regenerate loop for individual shots.

**Exit criteria:** a topic can be converted into an editable storyboard and rendered using approved templates.

### P2 — Scientific visual toolkit

- [ ] Build 2D primitives: labels, callouts, arrows, charts, grids, timelines, equations.
- [ ] Add Three.js scene integration for 3D objects and camera motion.
- [ ] Add optional Manim rendering/import for mathematical scenes.
- [ ] Create reusable science/technology visual templates.
- [ ] Add unit-aware chart and diagram helpers.

**Exit criteria:** common scientific and engineering concepts can be expressed mostly through reusable components.

### P3 — Production automation

- [ ] Integrate configurable TTS providers.
- [ ] Generate word- or sentence-aligned subtitles.
- [ ] Add music and sound-effect tracks with ducking.
- [ ] Build automated render and frame-sampling quality checks.
- [ ] Add batch rendering and resumable jobs.
- [ ] Export platform presets for landscape and vertical formats.

**Exit criteria:** one approved topic can flow through the pipeline to a publishable video with limited manual intervention.

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
- Do not claim a milestone is complete until the relevant command has run and output has been inspected.
