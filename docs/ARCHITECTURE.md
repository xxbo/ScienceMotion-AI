# Architecture

Last updated: 2026-11-14

## Direction and current boundaries

ScienceMotion AI is an agent-facing science-video framework intended to host hundreds of composable creative tools. Editorial meaning, project state, tool execution, artifacts and rendering are distinct boundaries.

P1.0 is the accepted local project foundation. P1.1 is active; A–E provide local infrastructure and the first F slice hardens local execution. The reviewed baseline `26f20bab6b56a6aa8774c80e5da25db84d00fefb` passed [CI #43463301921](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43463301921). The next architectural priority remains executable tools connected to visible project-driven output. [PLAN.md](PLAN.md) owns sequencing; [P1.1-ACCEPTANCE.md](P1.1-ACCEPTANCE.md) owns exit gates; [P1.1-F.md](P1.1-F.md) records the current execution slice and limits.

## Current project and rendering paths

Project Schema v1.1 models sequences, scenes, nodes/transforms/components, shots/tracks/clips, assets, prefabs, animation tracks, constraints, dependencies and revisions. The Episode package independently represents editorial content.

The Patch API currently implements node add/update/remove/reparent operations. Batches clone state and check revisions; the in-memory repository provides local CAS. Memory/filesystem snapshots hash and restore project data. These accepted mechanisms are not a complete transactional editing API for every entity or a physics solver.

The working Remotion video and SVG storyboard consume Episode data. CPU-cache scene types map to topic-specific components containing layout/animation and some text. The Project Graph fixture is validated separately; editing it is not yet the generic route to changing the rendered video.

```text
Current working render: Episode -> CPU-cache components -> MP4 / storyboard
Current platform:      Registry/Gateway + Project Graph + Artifact lifecycle
Next bridge:           executable tools -> project snapshot -> generic 2D renderer
```

## Planned creative bridge — P1.1-G

This section is target design, not implemented status.

Approved research/script/narration/caption content remains upstream. Agent planning uses discovered schemas to perform revisioned project edits. The host resolves approved content and pinned artifact dependencies into immutable render inputs. One canonical scene/timeline representation drives output; do not maintain an independent, conflicting timeline in the adapter.

A generic 2D adapter initially maps text, shapes, groups, transforms, opacity and explicitly supported keyframes to Remotion components. Topic-specific meaning stays in data, not new TSX scene types. Unsupported components/interpolation return diagnostics. Renderers neither call language models nor mutate editorial/project input.

Previews and video exports return Artifact references with minimal render evidence: snapshot hash/revision, tool/plugin selections, adapter version, profile and output hashes. A targeted tool edit followed by a new snapshot must change the expected visual result. The existing Episode demo stays as a regression fixture during this transition.

A thin discovery/invocation host supports deterministic scripted regression and one real AI trial through the same APIs. The general autonomous visual inspection/repair planner remains P1.4; forced execution isolation remains P1.2.

## Tool platform and F execution baseline

Manifests declare namespaced IDs, versions, schemas, descriptions/examples, categories/tags, capabilities, engines, project compatibility, cost, permissions and execution hints. Discovery supports filtering and pagination. Geometry manifests are currently catalogue fixtures.

The Gateway owns JSON Schema, permission/risk policy and configured Artifact checks. Its LocalToolExecutor owns synchronous pending publication, input-hash matching, owned atomic store reservations, retry, timeout/cancellation, capacity accounting and terminal evidence. Gateways sharing a store object share admission coordination. Call/key identities use JSON tuples; inputs/context and returned results are isolated copies.

ToolExecutionStore now uses reserve/finish ownership instead of independent save/update calls. Memory and optional exclusive-writer filesystem adapters implement this contract. The small local filesystem ledger has version/integrity validation, staged synced publication, conservative write-error handling and restart recovery of unfinished records to interrupted. Only confirmed success is replayed; uncertain effects require reconciliation. Records are retained rather than silently expired. The backend and stale-lock recovery procedure are scoped in P1.1-F.md.

Gateway defaults grant no declared permissions, block destructive/high-cost operations without explicit host authorization and bound invocation concurrency/deadlines. The future creative host must configure its policy explicitly. Hooks are observational; hook failures cannot rewrite committed outcomes. Shutdown stops admission and drains actual underlying work before store closure.

Timeouts and AbortSignal remain cooperative controls, not process isolation. Timed-out work keeps its concurrency slot until it settles and cannot later overwrite its terminal evidence. Forced termination and distributed guarantees belong to workers. Cancellation during storage admission is observed before starting the tool after the storage operation settles. Project/Artifact transactions and a complete effect-reconciliation protocol remain F work.

## Existing plugin versions and publication

The manager installs multiple plugin versions but publishes one active version per plugin ID. Installed metadata is copied/frozen. Activation checks pins, dependencies/dependents, reachable cycles, project compatibility and bounded candidate health while old tools remain available. Registration replacement/rollback is synchronous; lifecycle mutations during a transition return `PLUGIN_BUSY`.

Locks preserve exact choices; import validates before applying pins and does not download/install/activate code. Rollback restores registration selection, not external effects. Health checks are read-only; already-started calls may finish on old implementations. Supported dependency ranges are the stable exact/`*`/caret/tilde subset described in [P1.1-E.md](P1.1-E.md).

Keep this capability while validating real tool packages. Automatic solving, atomic multi-plugin upgrades, distribution and signatures are deferred rather than prerequisites for creative integration.

## Existing artifacts and planned consistency boundary

Artifacts use `sha256:<hex>` IDs and `artifact://sha256/<hex>` URIs. Binary bytes remain outside project JSON. Memory/filesystem stores deduplicate content and verify hashes on read; references identify artifact, owner and role. The lifecycle manager supports links/unlinks, reconciliation and age-based collection, and Gateway can retain tool outputs.

Current locks are per manager instance. Direct low-level deletion bypasses lifecycle checks; project persistence and reference updates are separate operations. P1.1-F must route destructive access through the host, add a tested local commit/recovery protocol, check asset consumers, repair changed-content references and preserve dependencies required by retained snapshots. Local data safety is required before creative-loop acceptance; cross-process shared-storage guarantees remain later work.

## Professional engines and deployment

Remotion remains the first video engine. Planned specialist adapters include Three.js for 3D, Blender for offline 3D/compositing, Manim for mathematics and FFmpeg for media processing. Reuse common project/tool/artifact contracts with explicit capability boundaries.

P1.2 introduces single-host isolated workers, job/progress/cancellation contracts and enforceable resources. P4 introduces remote execution/storage and cross-process transactions when needed. A plugin marketplace, remote package execution and a full Studio UI do not block the first local creative loop.

## Verification and document ownership

Existing successful metadata checks establish streams, dimensions/FPS and duration, not visual quality or generic project rendering. Planned acceptance combines deterministic project/tool/render tests, before/after previews, restore/failure checks, visual review, a real AI trial and a separate 300-entry synthetic catalogue test. Synthetic entries are not finished creative tools.

Historical P1.0 evidence: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025). P1.1-D evidence: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507). Plugin version tests cover the domain manager, real Registry/Gateway and manifest/lock schemas. F tests exercise atomic ownership, failure/cancellation/restart and a real revisioned repository mutation through Gateway. Documentation identity tests protect README, PLAN and ARCHITECTURE from accidental source-code or cross-document replacement.

Keep current behavior, target design and gate evidence separate. New runtime capabilities require tests and scoped documentation; the generic creative bridge remains planned work.
