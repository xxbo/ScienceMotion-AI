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
| P1.1-E | Multiple installed versions, pins/locks and guarded switching/rollback; integrated Creative Host administration and failure preservation |
| P1.1-F | Accepted trusted local creative host; CI #43783296488 passed |
| P1.1-G | Initial 2D tools and snapshot PNG/MP4 rendering; chart regressions and two-topic creation/edit/export/restart/restore automation |
| Inspection I1 | Read-only model diagnostics, declared shape/chart bounds and exact frame coverage |
| Inspection I2 | Production-browser text/element measurement without image encoding; font-ready line boxes, overflow warnings and heuristic font fallback |
| P1.1-H | Local AI-client interface, recorded interactive AI trial and separate CI replay; two-topic/plugin-switch regression; human review remains open |
| P1.2+ | Isolated workers, broader tools/professional engines and general autonomous visual iteration |

The built-in workspace plugin now includes initial scene, text, shape, transform and keyframe tools. The generic Project Graph composition is a first 2D slice; the CPU-cache Episode renderer remains separate. The [two-topic acceptance scenario](docs/P1.1-CREATIVE-LOOP.md) creates 12-second cache and water-cycle fixtures through public tools, detects/repairs seeded defects, edits text/motion and verifies export/restart/restore including original data dependencies. CI preserves six baseline/edited/restored MP4s, 18 previews, manifests and invocation evidence. These technical fixtures are silent and scripted.

Structured SVG paths and bar/line charts use the same Project Graph composition. Chart validation now covers the final SVG drawing and production-host PNG/MP4 pixels, including a targeted data edit; see [chart implementation and evidence](docs/P1.1-G-CHARTS.md). A passing data-projection test alone does not establish visible chart output.

## Next milestone

Connect the existing foundation into one public path:

```text
Approved content -> AI tool calls -> Project Graph -> immutable snapshot
  -> structured inspection -> targeted edit -> representative preview -> video export / restore
```

The current host has 19 executable built-ins; acceptance adds one executable test extension and grants 17 tools to the fixture workflow. One catalogue-only manifest and 300 synthetic scale entries (100 IDs × 3 versions) are counted separately. The scale entries are not implemented creative tools. Reuse Remotion and the existing contracts; marketplace/distributed infrastructure remains deferred.

P1.1 has evidence for 23/25 acceptance items, not an effort-completion percentage. [Host plugin switching and the 300-manifest scenario](docs/P1.1-PLUGIN-SWITCH-SCALE.md), plus the [local interface and recorded AI trial](docs/P1.1-AI-TRIAL.md), are implemented. Watch the trial's [12-second revised video](docs/ai-trials/cache-hit-2026-11-17/video-final.mp4): it was created through discovered tools and repaired from a layout report. CI separately replays that historical interaction; it does not run a new model trial. Next is final effect review, deferred by the user; the two remaining checklist items require that human review. See [Development Plan](docs/PLAN.md) and [P1.1 Acceptance](docs/P1.1-ACCEPTANCE.md).

## Development checks

Node.js 22 is used by CI.

```bash
npm install
npm run typecheck
npm test
npm run accept:catalogue-scale
npm run validate:episode
npm run validate:project
npm run validate:project-patch
npm run validate:tool-manifests
npm run validate:plugin-manifests
npm run render:storyboard
npm run inspect:snapshot-smoke
npm run inspect:layout-smoke
npm run accept:creative-loop
npm run accept:ai-trial
```

`npm run studio` and `npm run render` also generate narration and require the Python voice environment described by the repository's voice scripts and CI workflow.

`inspect:layout-smoke` requires the Remotion browser, Chinese fonts and FFmpeg for its two production PNG regressions. The `inspect.layout` tool itself returns measured JSON without encoding images or calling a visual model; see [scope and evidence](docs/P1.1-G-LAYOUT.md).

`accept:creative-loop` uses the same dependencies and writes to `out/creative-loop/`. Download CI's `creative-loop-evidence` artifact for the videos, previews and complete evidence; see [assertions and remaining gates](docs/P1.1-CREATIVE-LOOP.md).

`accept:catalogue-scale` needs no browser. It writes `out/catalogue-scale-evidence.json` with synthetic inventory, compatibility/conflict checks and machine-specific timings; CI includes it in `sciencemotion-demo`.

`host:stdio` exposes a project-bound JSON-lines process for AI clients; launch with a trusted config and explicit tool grants. `accept:ai-trial` validates the retained original trial and replays it through the CLI in a fresh workspace, writing separate media/evidence to `out/ai-trial/`. CI uploads `ai-trial-replay-evidence`. See [protocol, provenance and limitations](docs/P1.1-AI-TRIAL.md).

## Design and documentation

Content generation and rendering remain independent. Creative tools share the canonical Project Graph; renderers interpret approved data without rewriting meaning. Track executable tools, catalogue entries and visually verified outputs separately.

Read [Platform Vision](docs/PLATFORM_VISION.md), [Architecture](docs/ARCHITECTURE.md), and [P1.1-E implementation notes](docs/P1.1-E.md). The Project Graph now has an initial generic Remotion 2D composition and executable scene/text/shape/transform/animation tools. The CPU-cache Episode renderer remains a separate regression composition.
