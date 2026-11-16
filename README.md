# ScienceMotion AI

An extensible science-video creation framework for AI agents: discover typed tools, compose original graphics/animation, preview, revise and export. Grow to hundreds of tools without rewriting orchestration; templates remain optional accelerators.

## Current status

Watch the [30-second CPU-cache capability sample](docs/showcase/cpu-cache-30s.mp4) ([download MP4](https://raw.githubusercontent.com/xxbo/ScienceMotion-AI/main/docs/showcase/cpu-cache-30s.mp4)). It combines four scenes, text, shapes, paths, keyframes and a data-driven chart using the current public tools. Mandarin narration is added by a separate finishing script. [Reproduction, evidence and limits](docs/showcase/README.md).

Main is the delivery baseline. The merged chart/scene-selection fix on `020ae447bb81a6e727872188689407a14abac60c` passed [CI #43801547940](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43801547940) with 185 tests and render/pixel checks. Recorded SHAs are historical evidence; current source is main HEAD. **P1.1 remains active.**

| Stage | Implemented scope |
| --- | --- |
| P0 | Remotion, Mandarin TTS and MP4 pipeline; media polish remains open |
| P1.0 | Accepted local Project Graph, node patches/revisions, prefab/animation data and snapshots |
| P1.1-A–D | Local discovery/gateway, plugin lifecycle, execution records, content-addressed artifacts and references |
| P1.1-E | Multiple installed plugin versions, one active version, pins/locks, guarded switching and rollback |
| P1.1-F | Accepted trusted local creative host; CI #43783296488 passed |
| P1.1-G | Initial 2D tools and snapshot PNG/MP4 rendering implemented and CI-verified; chart drawing regression checks added; two-topic acceptance remains open |
| Inspection I1 | Read-only model diagnostics, declared shape/chart bounds and exact frame coverage; browser text/layout measurement is next |
| P1.1-H | Two-topic creative-loop and real AI invocation acceptance remains open |
| P1.2+ | Isolated workers, broader tools/professional engines and general autonomous visual iteration |

The built-in workspace plugin now includes initial scene, text, shape, transform and keyframe tools. The generic Project Graph composition is a first 2D slice; the CPU-cache Episode renderer remains separate. Snapshot-based PNG preview and MP4 render tools are implemented behind the Creative Host; the production Remotion host smoke test passed CI #43788856539 (177/177 tests). Two-topic creative-loop acceptance and broader tool families remain in progress.

Structured SVG paths and bar/line charts use the same Project Graph composition. Chart validation now covers the final SVG drawing and production-host PNG/MP4 pixels, including a targeted data edit; see [chart implementation and evidence](docs/P1.1-G-CHARTS.md). A passing data-projection test alone does not establish visible chart output.

## Next milestone

Connect the existing foundation into one public path:

```text
Approved content -> AI tool calls -> Project Graph -> immutable snapshot
  -> structured inspection -> targeted edit -> representative preview -> video export / restore
```

The planned proof uses roughly 10–12 executable tools and two short, different-topic fixtures, plus a separate 300-manifest synthetic catalogue test. Reuse Remotion and the existing contracts. Marketplace/distributed infrastructure is deferred until this creative loop works.

See [Development Plan](docs/PLAN.md) for sequencing and [P1.1 Acceptance](docs/P1.1-ACCEPTANCE.md) for measurable gates. These targets are not completed features.

## Development checks

Node.js 22 is used by CI.

```bash
npm install
npm run typecheck
npm test
npm run validate:episode
npm run validate:project
npm run validate:project-patch
npm run validate:tool-manifests
npm run validate:plugin-manifests
npm run render:storyboard
npm run inspect:snapshot-smoke
```

`npm run studio` and `npm run render` also generate narration and require the Python voice environment described by the repository's voice scripts and CI workflow.

## Design and documentation

Content generation and rendering remain independent. Creative tools share the canonical Project Graph; renderers interpret approved data without rewriting meaning. Track executable tools, catalogue entries and visually verified outputs separately.

Read [Platform Vision](docs/PLATFORM_VISION.md), [Architecture](docs/ARCHITECTURE.md), and [P1.1-E implementation notes](docs/P1.1-E.md). The Project Graph now has an initial generic Remotion 2D composition and executable scene/text/shape/transform/animation tools. The CPU-cache Episode renderer remains a separate regression composition.
