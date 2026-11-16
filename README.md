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
| P1.1-G | Initial 2D tools and snapshot PNG/MP4 rendering; chart regressions and two-topic creation/edit/export/restart/restore automation |
| Inspection I1 | Read-only model diagnostics, declared shape/chart bounds and exact frame coverage |
| Inspection I2 | Production-browser text/element measurement without image encoding; font-ready line boxes, overflow warnings and heuristic font fallback |
| P1.1-H | Deterministic two-topic workflow implemented; integrated plugin switching, real AI invocation and human review remain open |
| P1.2+ | Isolated workers, broader tools/professional engines and general autonomous visual iteration |

The built-in workspace plugin now includes initial scene, text, shape, transform and keyframe tools. The generic Project Graph composition is a first 2D slice; the CPU-cache Episode renderer remains separate. The [two-topic acceptance scenario](docs/P1.1-CREATIVE-LOOP.md) creates 12-second cache and water-cycle fixtures through public tools, detects/repairs seeded defects, edits text/motion and verifies export/restart/restore including original data dependencies. CI preserves six baseline/edited/restored MP4s, 18 previews, manifests and invocation evidence. These technical fixtures are silent and scripted.

Structured SVG paths and bar/line charts use the same Project Graph composition. Chart validation now covers the final SVG drawing and production-host PNG/MP4 pixels, including a targeted data edit; see [chart implementation and evidence](docs/P1.1-G-CHARTS.md). A passing data-projection test alone does not establish visible chart output.

## Next milestone

Connect the existing foundation into one public path:

```text
Approved content -> AI tool calls -> Project Graph -> immutable snapshot
  -> structured inspection -> targeted edit -> representative preview -> video export / restore
```

The current host has 19 executable built-ins; acceptance adds one executable test extension and grants 17 tools to the fixture workflow. One catalogue-only manifest and the planned 300-manifest scale scenario are counted separately. Reuse Remotion and the existing contracts; marketplace/distributed infrastructure remains deferred.

P1.1 has evidence for 18/25 acceptance items, not an effort-completion percentage. Next are integrated plugin switching and the 300-manifest scenario, then the local AI-client interface and a recorded real model trial. The user has deferred effect review to final acceptance; it remains pending. See [Development Plan](docs/PLAN.md) for sequencing and [P1.1 Acceptance](docs/P1.1-ACCEPTANCE.md) for measurable gates.

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
npm run inspect:layout-smoke
npm run accept:creative-loop
```

`npm run studio` and `npm run render` also generate narration and require the Python voice environment described by the repository's voice scripts and CI workflow.

`inspect:layout-smoke` requires the Remotion browser, Chinese fonts and FFmpeg for its two production PNG regressions. The `inspect.layout` tool itself returns measured JSON without encoding images or calling a visual model; see [scope and evidence](docs/P1.1-G-LAYOUT.md).

`accept:creative-loop` uses the same dependencies and writes to `out/creative-loop/`. Download CI's `creative-loop-evidence` artifact for the videos, previews and complete evidence; see [assertions and remaining gates](docs/P1.1-CREATIVE-LOOP.md).

## Design and documentation

Content generation and rendering remain independent. Creative tools share the canonical Project Graph; renderers interpret approved data without rewriting meaning. Track executable tools, catalogue entries and visually verified outputs separately.

Read [Platform Vision](docs/PLATFORM_VISION.md), [Architecture](docs/ARCHITECTURE.md), and [P1.1-E implementation notes](docs/P1.1-E.md). The Project Graph now has an initial generic Remotion 2D composition and executable scene/text/shape/transform/animation tools. The CPU-cache Episode renderer remains a separate regression composition.
