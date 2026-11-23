# ScienceMotion AI

An extensible science-video creation framework for AI agents: discover typed tools, compose original graphics/animation, preview, revise and export. Grow to hundreds of tools without rewriting orchestration; templates remain optional accelerators.

## Current status

Watch the [30-second CPU-cache capability sample](docs/showcase/cpu-cache-30s.mp4) ([download MP4](https://raw.githubusercontent.com/xxbo/ScienceMotion-AI/main/docs/showcase/cpu-cache-30s.mp4)). It combines four scenes, text, shapes, paths, keyframes and a data-driven chart using the current public tools. Mandarin narration is added by a separate finishing script. [Reproduction, evidence and limits](docs/showcase/README.md).

Main is the delivery baseline. P1.2-A's render-worker lifecycle was delivered on `b4e5bc9fa47111ce8a8324f69b14559d25d4f1de`. [CI #44002989900](https://github.com/xxbo/ScienceMotion-AI/actions/runs/44002989900) passed 223 tests and the real-render regressions. **P1.1 engineering is delivered and human review is deferred to final acceptance. P1.2 includes worker lifecycle, concurrent jobs, combined Linux resource limits, a render performance baseline and prepared bundle reuse.**

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
| P1.1-H | Local AI-client interface, recorded interactive AI trial and separate CI replay; two-topic/plugin-switch regression; human review assigned to final acceptance |
| P1.2-A | Opt-in Linux render workers, descendant cleanup, cancellation/deadlines and application progress callbacks |
| P1.2-B1 | [Job contract and durable ledger](docs/P1.2-B1-JOB-LEDGER.md): idempotency, owned transitions, progress/receipts and interruption evidence |
| P1.2-B2 | [Host/client jobs](docs/P1.2-B2-HOST-JOBS.md): authorized background submit/get/list/cancel, input retention, bounded admission and verified durable results; opt-in protocol 1.1 |
| P1.2-B3 | [Real CLI lifecycle](docs/P1.2-B3-CLI-LIFECYCLE.md): cancellation, process/temp cleanup, verified media and explicit interrupted-host recovery without replay |
| P1.2-C1 | [Concurrent scheduling](docs/P1.2-C1-SCHEDULING.md): independent waiting/running limits, per-project round-robin, lifecycle ownership and real simultaneous workers |
| P1.2-C2 | [Job retention administration](docs/P1.2-C2-RETENTION.md) with explicit reconciliation, release, pruning and GC protection |
| P1.2-C3 | Real-worker edits during an older render, scoped GC, plugin drain and host close with a full queue. [Concurrent maintenance acceptance](docs/P1.2-C3-CONCURRENT-MAINTENANCE.md) |
| P1.2-D1 | Trusted per-job budget contract and Linux capability evidence for cgroup delegation and bounded storage. [D1 resources](docs/P1.2-D1-RESOURCE-CAPABILITY.md) |
| P1.2-D2 | Delegated cgroup v2 CPU bandwidth, cumulative CPU time and memory budgets, with typed failure and cleanup. [D2 CPU and memory](docs/P1.2-D2-CPU-MEMORY.md) |
| P1.2-D3 | Dedicated ext4 loop volumes, kernel disk exhaustion, typed failure and reclamation. [D3 temporary disk](docs/P1.2-D3-TEMPORARY-DISK.md) |
| P1.2-D4 | Combined resource limits, parallel rendering through each failure, and verified slot and volume reuse. [D4 acceptance](docs/P1.2-D4-COMBINED-RESOURCES.md) |
| P1.2-E1 | Reproducible paired performance measurements with media, layout and cancellation verification. [E1 baseline](docs/P1.2-E1-PERFORMANCE-BASELINE.md) |
| P1.2-E2 | Opt-in prepared bundle reuse with disposable workers, invalidation and isolation checks. [E2 bundle reuse](docs/P1.2-E2-BUNDLE-REUSE.md) |
| P1.3-A | Approved PNG import, placement and snapshot rendering in the host and independent workers. [P1.3 plan](docs/P1.3-PLAN.md) |
| P1.3-B | Shot move, reorder and trim, PNG clips and frame-verified MP4 cuts. [Timeline editing](docs/P1.3-PLAN.md#b--timeline-editing) |
| P1.3-C | Edit existing shapes, SVG paths and charts, with pixel checks and exact snapshot recovery. [Graphics editing](docs/P1.3-PLAN.md#c--edit-existing-2d-graphics) |
| P1.3-D | Individual keyframe edits, scene-local easing and a frame-verified shot crossfade. [Keyframes and crossfades](docs/P1.3-PLAN.md#d--keyframes-and-crossfades) |
| P1.3-E | WAV narration, timed captions and verified AAC and caption boundaries in MP4 exports. [Narration and captions](docs/P1.3-PLAN.md#e--narration-and-timed-captions) |
| P1.3-F | Read-only timeline inspection, targeted repairs and verified recovery of an eight-second narrated short. [Integrated inspection and repair](docs/P1.3-PLAN.md#f--integrated-inspection-and-repair) |

The built-in workspace plugin now includes initial scene, text, shape, transform and keyframe tools. The generic Project Graph composition is a first 2D slice; the CPU-cache Episode renderer remains separate. The [two-topic acceptance scenario](docs/P1.1-CREATIVE-LOOP.md) creates 12-second cache and water-cycle fixtures through public tools, detects/repairs seeded defects, edits text/motion and verifies export/restart/restore including original data dependencies. CI preserves six baseline/edited/restored MP4s, 18 previews, manifests and invocation evidence. These technical fixtures are silent and scripted.

Structured SVG paths and bar/line charts use the same Project Graph composition. Chart validation now covers the final SVG drawing and production-host PNG/MP4 pixels, including a targeted data edit; see [chart implementation and evidence](docs/P1.1-G-CHARTS.md). A passing data-projection test alone does not establish visible chart output.

## Next milestone

The delivered P1.1 path is:

```text
Approved content -> AI tool calls -> Project Graph -> immutable snapshot
  -> structured inspection -> targeted edit -> representative preview -> video export / restore
```

The host has 25 executable built-ins. The P1.1 two-topic scenario adds one executable test extension. The catalogue also includes one catalogue-only manifest and 300 synthetic scale entries (100 IDs × 3 versions).

P1.1 has evidence for 23 of 25 acceptance items, and the two human-review items are assigned to final acceptance. The recorded AI trial created a 12-second video through discovered tools and repaired it using a layout report. [P1.1 acceptance](docs/P1.1-ACCEPTANCE.md) · [Sample review](docs/P1.1-REVIEW.md) · [Recorded AI trial](docs/P1.1-AI-TRIAL.md) · [Revised video](docs/ai-trials/cache-hit-2026-11-17/video-final.mp4).

P1.2 and P1.3 are implemented. P1.4-A and B validate provider-independent proposals and feed tool results back into a bounded run. The acceptance scenario saves and reopens a two-shot draft. P1.4-C will use inspection findings to drive repairs. [P1.4 plan](docs/P1.4-PLAN.md).

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
npm run accept:render-worker
npm run accept:render-jobs
npm run accept:render-scheduler
npm run accept:render-maintenance
npm run accept:p1-3
npm run accept:p1-4-b
npm run --silent probe:render-resources
```

`npm run studio` and `npm run render` also generate narration and require the Python voice environment described by the repository's voice scripts and CI workflow.

`inspect:layout-smoke` requires the Remotion browser, Chinese fonts and FFmpeg for its two production PNG regressions. The `inspect.layout` tool itself returns measured JSON without encoding images or calling a visual model; see [scope and evidence](docs/P1.1-G-LAYOUT.md).

`accept:creative-loop` uses the same dependencies and writes to `out/creative-loop/`. Download CI's `creative-loop-evidence` artifact for the videos, previews and complete evidence; see [assertions and remaining gates](docs/P1.1-CREATIVE-LOOP.md).

`accept:catalogue-scale` needs no browser. It writes `out/catalogue-scale-evidence.json` with synthetic inventory, compatibility/conflict checks and machine-specific timings; CI includes it in `sciencemotion-demo`.

`host:stdio` exposes a project-bound JSON-lines process for AI clients; launch with a trusted config and explicit tool grants. `accept:ai-trial` validates the retained original trial and replays it through the CLI in a fresh workspace, writing separate media/evidence to `out/ai-trial/`. CI uploads `ai-trial-replay-evidence`. See [protocol, provenance and limitations](docs/P1.1-AI-TRIAL.md).

`accept:render-worker` runs the same CLI replay with `renderWorker: {}` in trusted launch configuration, then cancels a real video after frame progress, verifies Chromium/FFmpeg cleanup and absence of a cancelled Artifact, and renders a new preview. It requires Linux and Python 3 in addition to renderer dependencies. CI uploads `out/ai-trial-worker/` as `render-worker-evidence`. The default host remains in process; enable workers explicitly.

`render:job-smoke` verifies [B2's background host API](docs/P1.2-B2-HOST-JOBS.md) with an actual PNG/MP4, byte receipts and result queries after reopen. CI uploads `out/job-host-*` in `sciencemotion-demo`. Select `protocolVersion: "1.1.0"` in trusted local launch configuration to use `jobs.submit/get/list/cancel`; existing 1.0 clients remain unchanged. Keep the connection open while jobs run: EOF/close cancels and drains them. `accept:render-jobs` verifies this protocol through real worker cancellation, process/temp cleanup, PNG/MP4 output and explicit interrupted-host recovery without replay. CI uploads `out/render-job-cli/` as `render-job-cli-evidence`; see [B3 scope and recovery boundaries](docs/P1.2-B3-CLI-LIFECYCLE.md).

`accept:render-scheduler` verifies two actual concurrent worker/Chromium trees, bounded waiting capacity, two MP4s and a PNG, cleanup and exact reopened results. CI uploads `out/render-job-scheduler/` as `render-scheduler-evidence`. Configure `renderJobs.maxConcurrentJobs` and `maxQueuedJobs` independently, and give the selected worker sufficient capacity. [C1 configuration and scope](docs/P1.2-C1-SCHEDULING.md).

`host.maintenance.renderJobs` lets a trusted application inspect job retention, reconcile an interrupted or uncertain outcome, release job-owned output references and prune a released record. The real `render:job-smoke` verifies targeted output GC and checks the pruned identity after reopening. [C2 API and evidence](docs/P1.2-C2-RETENTION.md).

`accept:render-maintenance` verifies an edited snapshot and an unchanged in-flight render, GC before and after release, plugin switching and host close with a full queue. CI saves the decoded-pixel and restart evidence with the three rendered files in `render-maintenance-evidence`. [C3 scenario and evidence](docs/P1.2-C3-CONCURRENT-MAINTENANCE.md).

`probe:render-resources` reports Linux controller availability and can verify temporary filesystem capacity on a disposable file-backed loop volume. Set `renderWorker.cgroupParent` and `renderWorker.resourceBudget` to enforce CPU and memory budgets on the delegated Linux runtime. CI verifies throttling, OOM, cleanup and a real budgeted MP4. [D1 capability probe](docs/P1.2-D1-RESOURCE-CAPABILITY.md) · [D2 configuration and evidence](docs/P1.2-D2-CPU-MEMORY.md).

Set `renderWorker.temporaryVolumes` and `renderWorker.resourceBudget.temporaryBytes` to give each job a dedicated temporary filesystem. CI verifies kernel `ENOSPC`, durable failure, capacity reclamation and a production render on the same volume. [D3 configuration and evidence](docs/P1.2-D3-TEMPORARY-DISK.md).

The combined acceptance enables all resource budgets in the same host, verifies CPU, memory and disk failures in separate rounds, and checks a parallel video and a queued preview after each failure. [D4 combined acceptance](docs/P1.2-D4-COMBINED-RESOURCES.md).

`npm run bench:render` compares isolated in-process and worker runs over the same snapshot. It writes raw timings and a summary under `out/render-performance/`. [E1 reproduction and metrics](docs/P1.2-E1-PERFORMANCE-BASELINE.md).

`npm run bench:render -- --compare bundle` compares worker requests with and without a prepared bundle and includes build time in the sample totals. [E2 preparation and metrics](docs/P1.2-E2-BUNDLE-REUSE.md).

`npm run accept:p1-3` creates, inspects, repairs, exports and recovers a short through the public tools. CI publishes the videos, previews, inspection reports and execution trace as `integrated-creative-evidence`. [P1.3-F verification](docs/P1.3-PLAN.md#f--integrated-inspection-and-repair).

`npm run accept:p1-4-b` runs local planning against the Creative Host, saves and reopens a draft and reconciles a deliberately lost response against the execution ledger. CI publishes the run traces, draft and ledger entries as `creative-run-evidence`. [P1.4-B verification](docs/P1.4-PLAN.md#b--bounded-execution).

## Design and documentation

Content generation and rendering remain independent. Creative tools share the canonical Project Graph; renderers interpret approved data without rewriting meaning. Track executable tools, catalogue entries and visually verified outputs separately.

Read [Platform Vision](docs/PLATFORM_VISION.md), [Architecture](docs/ARCHITECTURE.md), and [P1.1-E implementation notes](docs/P1.1-E.md). The Project Graph now has an initial generic Remotion 2D composition and executable scene/text/shape/transform/animation tools. The CPU-cache Episode renderer remains a separate regression composition.
