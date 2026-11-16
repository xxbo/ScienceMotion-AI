# Architecture

Last updated: 2026-11-15

## Direction and current boundaries

ScienceMotion AI is an agent-facing science-video framework intended to host hundreds of composable creative tools. Editorial meaning, project state, tool execution, artifacts and rendering are distinct boundaries.

P1.0 is the accepted local project foundation. P1.1 is active; A–E provide local infrastructure, F is accepted as a trusted local host baseline, and G is connecting executable creative tools to generic Project Graph rendering. The execution baseline `2566bd0de8b95b27a6adeeeb188c5d854f2b73e5` passed [CI #43612600513](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43612600513). The next architectural priority remains executable tools connected to visible project-driven output. [PLAN.md](PLAN.md) owns sequencing; [P1.1-ACCEPTANCE.md](P1.1-ACCEPTANCE.md) owns exit gates; [P1.1-F.md](P1.1-F.md) and [project/asset consistency](P1.1-F-PROJECT-ASSETS.md) record implemented scope and limits.

## Current project and rendering paths

Project Schema v1.1 models sequences, scenes, nodes/transforms/components, shots/tracks/clips, assets, prefabs, animation tracks, constraints, dependencies and revisions. The Episode package independently represents editorial content.

Patch protocol 1.1.0 preserves node add/update/remove/reparent operations. Protocol 1.2.0 adds asset add/replace/remove without changing ProjectDocument 1.1.0. Batches clone state and check revisions; asset removal rejects declared consumers. The in-memory repository supplies local CAS, and the optional filesystem workspace persists canonical documents and retained snapshots through a conservative reference protocol. Scene/shot/animation editing is implemented through Patch protocol 1.3.0; complete graph-to-render integration remains open.

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

ToolExecutionStore uses reserve/finish ownership instead of independent save/update calls. Memory and optional exclusive-writer filesystem adapters implement this contract. The small local filesystem ledger has version/integrity validation, staged synced publication, conservative write-error handling and restart recovery of unfinished records to interrupted. Only confirmed success is replayed; uncertain effects require reconciliation. Records are retained rather than silently expired. The backend and stale-lock recovery procedure are scoped in P1.1-F.md.

Gateway defaults grant no declared permissions, block destructive/high-cost operations without explicit host authorization and bound invocation concurrency/deadlines. The future creative host must configure its policy explicitly. Hooks are observational; hook failures cannot rewrite committed outcomes. Shutdown stops admission and drains actual underlying work before store closure.

Timeouts and AbortSignal remain cooperative controls, not process isolation. Timed-out work keeps its concurrency slot until it settles and cannot later overwrite its terminal evidence. Forced termination and distributed guarantees belong to workers. Cancellation during storage admission is observed before starting the tool after storage settles. Project publication and execution evidence are separate ledgers: callers reconcile persisted revisions after uncertain outcomes; no universal exactly-once side-effect guarantee is implied.

## Existing plugin versions and publication

The manager installs multiple plugin versions but publishes one active version per plugin ID. Installed metadata is copied/frozen. Activation checks pins, dependencies/dependents, reachable cycles, project compatibility and bounded candidate health while old tools remain available. Registration replacement/rollback is synchronous; lifecycle mutations during a transition return `PLUGIN_BUSY`.

Locks preserve exact choices; import validates before applying pins and does not download/install/activate code. Rollback restores registration selection, not external effects. Health checks are read-only; already-started calls may finish on old implementations. Supported dependency ranges are the stable exact/`*`/caret/tilde subset described in [P1.1-E.md](P1.1-E.md).

Keep this capability while validating real tool packages. Automatic solving, atomic multi-plugin upgrades, distribution and signatures are deferred rather than prerequisites for creative integration.

## Artifact and workspace consistency

Artifacts use `sha256:<hex>` IDs and `artifact://sha256/<hex>` URIs. Binary bytes remain outside project JSON. Memory/filesystem stores deduplicate content and verify hashes. Filesystem immutable publication uses unique staged/synced files and exclusive links. References identify artifact, owner and role; related lifecycle instances sharing one reference-store object serialize mutations with collection. Independently constructed stores/processes over the same directories are not a shared transaction system.

Only canonical Artifact URIs denote locally managed dependencies. External URI hashes do not confer local ownership. Reconciliation verifies actual bytes, matches both role and content identity and preserves old references when dependencies are missing or invalid. Consumer checks cover clips, dependency edges and component assetId/assetIds fields; custom references must declare dependency edges. No automatic cascade is implemented.

`FileSystemProjectWorkspace` implements the existing ProjectRepository over canonical ProjectDocument and ProjectSnapshot objects. A versioned checksummed ledger records heads, retained snapshots and an in-progress intent. A commit persists old heads plus intent, acquires temporary pins, publishes the new state, reconciles permanent references, then releases pins and clears intent. On failure the instance blocks further mutations/GC until reopened. Recovery trusts the published ledger, verifies dependencies and repairs conservatively. A failed response does not prove the data publication was rolled back.

Workspace project reference roles include workspace identity; snapshot owners include workspace/project/snapshot identities. Current project edits cannot release retained-snapshot or other-owner references. Restore appends a fresh revision; snapshot release is explicit. One exclusive workspace writer and shared host lifecycle composition are required. The state ledger is deliberately small and local, not a parallel creative model or distributed database.

Legacy standalone snapshot files are not automatically enrolled in retention. Detached-document lifecycle helpers are compatibility utilities; persisted creative edits use the workspace. Raw low-level deletion still bypasses lifecycle protection and must remain private to host storage composition. First creative-host wiring/policy, scheduled GC and remote/shared storage remain open. Details and failure tests: [P1.1-F-PROJECT-ASSETS.md](P1.1-F-PROJECT-ASSETS.md).

## Professional engines and deployment

Remotion remains the first video engine. Planned specialist adapters include Three.js for 3D, Blender for offline 3D/compositing, Manim for mathematics and FFmpeg for media processing. Reuse common project/tool/artifact contracts with explicit capability boundaries.

P1.2 introduces single-host isolated workers, job/progress/cancellation contracts and enforceable resources. P4 introduces remote execution/storage and cross-process transactions when needed. A plugin marketplace, remote package execution and a full Studio UI do not block the first local creative loop.

## Verification and document ownership

Existing successful metadata checks establish streams, dimensions/FPS and duration, not visual quality or generic project rendering. Planned acceptance combines deterministic project/tool/render tests, before/after previews, restore/failure checks, visual review, a real AI trial and a separate 300-entry synthetic catalogue test. Synthetic entries are not finished creative tools.

Historical P1.0 evidence: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025). P1.1-D evidence: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507). Plugin version tests cover the domain manager, real Registry/Gateway and schemas. F tests cover execution admission/restart, revisioned edits, workspace/reference publication failures, snapshot retention and local store reopen. Documentation identity tests protect README, PLAN and ARCHITECTURE from accidental source-code or cross-document replacement.

Keep current behavior, target design and gate evidence separate. New runtime capabilities require tests and scoped documentation; the generic creative bridge remains planned work.


## P1.1-F creative host — implemented local composition

`openCreativeHost()` is the single trusted application entry point for the local host. It acquires an exclusive workspace lock, opens the filesystem project workspace, shared artifact/reference lifecycle and persistent execution ledger, validates and activates exact plugin versions, then composes Registry and Gateway. Startup recovery completes before sessions are admitted.

The host exposes project-bound sessions. Each session receives an explicit tool allow-list and permission grant; omitted permissions/tools mean none. Tool discovery is filtered by the grant. Invocation requires the exact discovered tool version and is scoped to the session project. Service operations independently require the session grant, plugin declaration and tool declaration. Destructive operations additionally require explicit host approval and a destructive tool declaration. Input, project, patch, artifact, session, concurrency and timeout limits are bounded by host policy.

The built-in `builtin.workspace` plugin exposes project create/inspect, revisioned patch apply, separately approved removal, snapshot save/inspect/restore and execution-history inspection. It is a workspace/validation tool family, not the P1.1-G graphics/animation/render tool suite. Plugin code receives scoped services rather than raw stores or filesystem paths. Artifact reads verify project/invocation ownership and actual bytes; snapshot dependencies are pinned to the invocation. The host owns GC and snapshot release.

Shutdown stops new admission, drains Gateway work and queued service operations, closes persistent resources, then releases the exclusive lock. Startup validation failures close acquired resources. A corrupt authoritative workspace fails closed rather than silently resetting project data. This is a trusted in-process, single-writer local host; it is not a third-party sandbox or distributed transaction system.

Patch protocol 1.3.0 now has JSON Schema coverage for scene, shot and animation operations. ProjectDocument remains 1.1.0; its animation-track schema explicitly requires `targetNodeId` and permits `enabled`, matching the TypeScript model. The existing Episode/CPU-cache renderer remains independent; Project Snapshot rendering is still P1.1-G.


### CI correction — Patch Schema strict array typing

After the self-contained keyframe reference fix, all 170 platform tests passed. The next CI step then failed because the Patch 1.2.0 conditional schema constrained `patches.items` without declaring `patches.type: array`, which Ajv strictTypes rejects. Added the missing array type. The validation script now compiles the Patch Schema independently in strict mode and rejects all external `$ref` dependencies, preventing both regressions.


## P1.1-G first Project Graph renderer slice

The first data-driven 2D render path is implemented in `src/renderers/remotion/project-render-model.ts` and `src/compositions/ProjectGraphComposition.tsx`. It selects the active scene/shot, traverses scene hierarchy and composes group transforms, renders text and basic geometric primitives, and samples supported position/rotation/scale/opacity tracks. Unsupported node and animation cases produce structured diagnostics. The existing Episode/CPU-cache composition remains separately registered and unchanged.

The `builtin.workspace` plugin now exposes executable `project.scene.create`, `graphics.2d.text.create`, `graphics.2d.shape.create`, `project.node.transform.set`, and `animation.keyframes.set` tools through the same scoped host/Registry/Gateway and Patch 1.3.0 boundary. A water-cycle Project Graph fixture is registered as a second Remotion composition and CI renders a 10-second 1080p/30fps MP4 with Project Schema and ffprobe validation. The host integration test creates and edits a project only through these public tools, then projects the resulting document into a render model.

This is the first vertical slice, not full P1.1-G completion. Preview/video Artifact services, immutable snapshot render requests, asset import, paths/SVG, typography/layout, transitions, audio/captions, 3D and visual review remain open. See [P1.1-G first slice](P1.1-G-FIRST-SLICE.md).


## P1.1-G first vertical slice — CI verified

Commit `c826aa56c1c0d9c6ff977e97f0ae724d1e9310cb` passed [CI #43786811086](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43786811086): 175/175 platform tests, Project Patch/tool/plugin validation, a generic Project Graph MP4 render (H.264, 1920×1080, 30 FPS, 10.00s), and the separate legacy Episode/CPU-cache render with audio validation. The generic render uses the data-driven water-cycle fixture and the new Remotion Project Graph composition. The full P1.1 creative-loop gates remain open: tool-created project rendering through a retained snapshot, render Artifact services, second-topic reuse, visual review, 300-entry discovery scale and a real AI invocation trial.
