# ScienceMotion AI

AI-assisted, code-driven science explainer video production.

ScienceMotion AI turns a topic into a researched script, storyboard, deterministic motion-graphics scenes, narration, captions, and a rendered video. The first milestone is a reliable, reusable video engine—not a one-off generated clip.

## Project principles

- **Code-first visuals:** use deterministic 2D/3D graphics for diagrams, labels, equations, and mechanisms.
- **Scientific correctness:** keep claims, assumptions, units, and sources traceable.
- **Reusable scenes:** build composable scene primitives and templates.
- **Human review:** generated scripts and storyboards are reviewable before rendering.
- **Reproducible output:** fixed frame timing and explicit render settings.

## Stack

- TypeScript + React
- Remotion for composition and frame-accurate rendering
- SVG / CSS for 2D motion graphics
- Three.js for later 3D scenes
- Manim as an optional specialist renderer for mathematical scenes
- FFmpeg through the rendering pipeline for media processing

## Quick start

Requirements: Node.js 20.19+ (or a compatible current LTS) and npm.

```bash
npm install
npm run studio
```

Render the starter composition:

```bash
npm run render
```

The output is written to `out/science-motion-demo.mp4`.

## Current milestone

**P0 — Video engine validation**

- [x] Establish project architecture and engineering plan
- [x] Add a Remotion composition with a timed multi-scene demo
- [ ] Install dependencies and verify local studio startup
- [ ] Render and inspect a 1080p MP4
- [ ] Add narration, subtitles, and audio mixing
- [ ] Build the first CPU cache explainer

See [docs/PLAN.md](docs/PLAN.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
