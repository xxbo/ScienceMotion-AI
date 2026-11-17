# Architecture

Last updated: 2026-11-16

## Direction and current boundaries

ScienceMotion AI is an agent-facing science-video framework intended to host hundreds of composable creative tools. Editorial meaning, project state, tool execution, artifacts and rendering are distinct boundaries.

P1.0 is the accepted local project foundation. P1.1 is active; A–E provide local infrastructure, F is accepted as a trusted local host baseline, and G is connecting executable creative tools to generic Project Graph rendering. The execution baseline `2566bd0de8b95b27a6adeeeb188c5d854f2b73e5` passed [CI #43612600513](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43612600513). The next architectural priority remains executable tools connected to visible project-driven output. [PLAN.md](PLAN.md) owns sequencing; [P1.1-ACCEPTANCE.md](P1.1-ACCEPTANCE.md) owns exit gates; [P1.1-F.md](P1.1-F.md) and [project/asset consistency](P1.1-F-PROJECT-ASSETS.md) record implemented scope and limits.

## Current project and rendering paths

Project Schema v1.1 models sequences, scenes, nodes/transforms/components, shots/tracks/clips, assets, prefabs, animation tracks, constraints, dependencies and revisions. The Episode package independently represents editorial content.

Patch protocol 1.1.0 preserves node add/update/remove/reparent operations. Protocol 1.2.0 adds asset add/replace/remove without changing ProjectDocument 1.1.0. Batches clone state and check revisions; asset removal rejects declared consumers. The in-memory repository supplies local CAS, and the optional filesystem workspace persists canonical documents and retained snapshots through a conservative reference protocol. Scene/shot/animation editing is implemented through Patch protocol 1.3.0; complete graph-to-render integration remains open.

The legacy Remotion video and SVG storyboard consume Episode data; CPU-cache scene types map to topic-specific components. The generic Project Graph composition is a separate working route: public tools edit the canonical project, immutable snapshots supply render inputs, and the Creative Host returns PNG/MP4 Artifacts. Its initial 2D subset includes text, shapes, paths, charts and supported transform/opacity keyframes.

```text
Legacy regression: Episode -> CPU-cache components -> MP4 / storyboard
Creative path:     Registry/Gateway tools -> Project Graph -> immutable snapshot
                   -> generic 2D Remotion composition -> PNG / MP4 Artifacts
```

## Initial creative bridge — P1.1-G

The initial tools, snapshot render path and two-topic creation/edit/restart/restore workflow are implemented, including integrated plugin-switch/failure acceptance. Real AI invocation and human visual review remain open; see PLAN and P1.1-ACCEPTANCE.

Approved research/script/narration/caption content remains upstream. Agent planning uses discovered schemas to perform revisioned project edits. The host resolves approved content and pinned artifact dependencies into immutable render inputs. One canonical scene/timeline representation drives output; do not maintain an independent, conflicting timeline in the adapter.

A generic 2D adapter initially maps text, shapes, groups, transforms, opacity and explicitly supported keyframes to Remotion components. Topic-specific meaning stays in data, not new TSX scene types. Unsupported components/interpolation return diagnostics. Renderers neither call language models nor mutate editorial/project input.

Previews and video exports return Artifact references with minimal render evidence: snapshot hash/revision, tool/plugin selections, adapter version, profile and output hashes. A targeted tool edit followed by a new snapshot must change the expected visual result. The existing Episode demo stays as a regression fixture during this transition.

A thin discovery/invocation host supports deterministic scripted regression and one real AI trial through the same APIs. The general autonomous visual inspection/repair planner remains P1.4; forced execution isolation remains P1.2.

## Tool platform and F execution baseline

Manifests declare namespaced IDs, versions, schemas, descriptions/examples, categories/tags, capabilities, engines, project compatibility, cost, permissions and execution hints. Discovery supports filtering and pagination. Geometry manifests are currently catalogue fixtures.

The Gateway owns JSON Schema, permission/risk policy and configured Artifact checks. Its LocalToolExecutor owns synchronous pending publication, input-hash matching, owned atomic store reservations, retry, timeout/cancellation, capacity accounting and terminal evidence. Gateways sharing a store object share admission coordination. Call/key identities use JSON tuples; inputs/context and returned results are isolated copies.

ToolExecutionStore uses reserve/finish ownership instead of independent save/update calls. Memory and optional exclusive-writer filesystem adapters implement this contract. The small local filesystem ledger has version/integrity validation, staged synced publication, conservative write-error handling and restart recovery of unfinished records to interrupted. Only confirmed success is replayed; uncertain effects require reconciliation. Records are retained rather than silently expired. The backend and stale-lock recovery procedure are scoped in P1.1-F.md.

Gateway defaults grant no declared permissions, block destructive/high-cost operations without explicit host authorization and bound invocation concurrency/deadlines. The creative host configures its policy explicitly. Hooks are observational; hook failures cannot rewrite committed outcomes. Shutdown stops admission and drains actual underlying work before store closure.

Gateway timeouts and AbortSignal remain cooperative for general trusted plugin work. Timed-out work keeps its concurrency slot until it settles and cannot later overwrite terminal evidence. Opt-in [render workers](P1.2-WORKERS.md) add a Linux process boundary with forced termination/reaping for rendering and layout measurement. Cancellation during storage admission is observed before starting the tool after storage settles. Project publication and execution evidence are separate ledgers: callers reconcile persisted revisions after uncertain outcomes; no universal exactly-once side-effect guarantee is implied.

## Existing plugin versions and publication

The manager installs multiple plugin versions but publishes one active version per plugin ID. Installed metadata is copied/frozen. Activation checks pins, dependencies/dependents, reachable cycles, project compatibility and bounded candidate health while old tools remain available. Registration replacement/rollback is synchronous; lifecycle mutations during a transition return `PLUGIN_BUSY`.

The production host exposes trusted `plugins.install/activate/list/exportLock` administration. It pauses admission and drains actual calls before using the manager, then refreshes the catalogue and session gateways with unchanged grants. Reused tool IDs require distinct versions across installed plugin implementations. A failed upgrade preserves the prior selection/pin; restart uses factories explicitly supplied by the application. This interface is not exposed to AI tools. [Host switching and scale evidence](P1.1-PLUGIN-SWITCH-SCALE.md) defines the boundary and tests.

Locks preserve exact choices; import validates before applying pins and does not download/install/activate code. Rollback restores registration selection, not external effects. Health checks are read-only; already-started calls may finish on old implementations. Supported dependency ranges are the stable exact/`*`/caret/tilde subset described in [P1.1-E.md](P1.1-E.md).

Keep this capability while validating real tool packages. Automatic solving, atomic multi-plugin upgrades, distribution and signatures are deferred rather than prerequisites for creative integration.

## Artifact and workspace consistency

Artifacts use `sha256:<hex>` IDs and `artifact://sha256/<hex>` URIs. Binary bytes remain outside project JSON. Memory/filesystem stores deduplicate content and verify hashes. Filesystem immutable publication uses unique staged/synced files and exclusive links. References identify artifact, owner and role; related lifecycle instances sharing one reference-store object serialize mutations with collection. Independently constructed stores/processes over the same directories are not a shared transaction system.

Only canonical Artifact URIs denote locally managed dependencies. External URI hashes do not confer local ownership. Reconciliation verifies actual bytes, matches both role and content identity and preserves old references when dependencies are missing or invalid. Consumer checks cover clips, dependency edges and component assetId/assetIds fields; custom references must declare dependency edges. No automatic cascade is implemented.

`FileSystemProjectWorkspace` implements the existing ProjectRepository over canonical ProjectDocument and ProjectSnapshot objects. A versioned checksummed ledger records heads, retained snapshots and an in-progress intent. A commit persists old heads plus intent, acquires temporary pins, publishes the new state, reconciles permanent references, then releases pins and clears intent. On failure the instance blocks further mutations/GC until reopened. Recovery trusts the published ledger, verifies dependencies and repairs conservatively. A failed response does not prove the data publication was rolled back.

Workspace project reference roles include workspace identity; snapshot owners include workspace/project/snapshot identities. Current project edits cannot release retained-snapshot or other-owner references. Restore appends a fresh revision; snapshot release is explicit. One exclusive workspace writer and shared host lifecycle composition are required. The state ledger is deliberately small and local, not a parallel creative model or distributed database.

Legacy standalone snapshot files are not automatically enrolled in retention. Detached-document lifecycle helpers are compatibility utilities; persisted creative edits use the workspace. Raw low-level deletion still bypasses lifecycle protection and must remain private to host storage composition. Creative-host wiring/policy is implemented; scheduled GC and remote/shared storage remain deferred. Details and failure tests: [P1.1-F-PROJECT-ASSETS.md](P1.1-F-PROJECT-ASSETS.md).

## Snapshot inspection — implemented I1 and planned I2

The public `inspect.snapshot` tool requires only `snapshot.read`. Its scoped service validates the retained snapshot's project ownership and canonical document, then verifies identity/hash and runs the bounded model inspector. The tool returns a versioned JSON report with snapshot/revision identity, exact checked frames, grouped diagnostics and explicit unchecked domains; node/track IDs also flow into ToolResult diagnostics. It does not call the renderer or a vision provider, create media artifacts or mutate project state. Execution evidence is persisted normally.

I1 reuses `buildProjectRenderModel` and checks declared affine shape/chart bounds. Short sequences up to 120 frames are checked exhaustively; longer sequences are sampled and coverage is disclosed. Selection/projection work and issue counts are bounded. Browser text layout, path ink extents, occlusion, asset bytes, final pixels/audio and content/presentation quality are outside I1. Missing findings do not establish video correctness. See [Snapshot inspection](P1.1-G-INSPECTION.md).

I2 will measure actual font/layout results from the same Remotion/browser composition and snapshot. Measurements are immutable evidence, not a second scene model. The AI consumes structured findings and edits through normal revisioned tools; representative pixel/visual checks remain separate acceptance evidence.

## Professional engines and deployment

Remotion remains the first video engine. Planned specialist adapters include Three.js for 3D, Blender for offline 3D/compositing, Manim for mathematics and FFmpeg for media processing. Reuse common project/tool/artifact contracts with explicit capability boundaries.

P1.2 introduces single-host isolated workers, job/progress/cancellation contracts and enforceable resources. P4 introduces remote execution/storage and cross-process transactions when needed. A plugin marketplace, remote package execution and a full Studio UI do not block the first local creative loop.

## Verification and document ownership

Existing successful metadata checks establish streams, dimensions/FPS and duration, not visual quality or generic project rendering. Planned acceptance combines deterministic project/tool/render tests, before/after previews, restore/failure checks, visual review, a real AI trial and a separate 300-entry synthetic catalogue test. Synthetic entries are not finished creative tools.

Historical P1.0 evidence: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025). P1.1-D evidence: [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507). Plugin version tests cover the domain manager, real Registry/Gateway and schemas. F tests cover execution admission/restart, revisioned edits, workspace/reference publication failures, snapshot retention and local store reopen. Documentation identity tests protect README, PLAN and ARCHITECTURE from accidental source-code or cross-document replacement.

Keep current behavior, target design and gate evidence separate. New runtime capabilities require tests and scoped documentation; full creative-loop acceptance remains open.


## P1.1-F creative host — implemented local composition

`openCreativeHost()` is the single trusted application entry point for the local host. It acquires an exclusive workspace lock, opens the filesystem project workspace, shared artifact/reference lifecycle and persistent execution ledger, validates and activates exact plugin versions, then composes Registry and Gateway. Startup recovery completes before sessions are admitted.

The host exposes project-bound sessions. Each session receives an explicit tool allow-list and permission grant; omitted permissions/tools mean none. Tool discovery is filtered by the grant. Invocation requires the exact discovered tool version and is scoped to the session project. Service operations independently require the session grant, plugin declaration and tool declaration. Destructive operations additionally require explicit host approval and a destructive tool declaration. Input, project, patch, artifact, session, concurrency and timeout limits are bounded by host policy.

The built-in `builtin.workspace` plugin exposes project/revision/snapshot operations, execution history, initial 2D creation/animation tools, snapshot rendering and model/browser inspection. The current inventory is listed in [P1.1 acceptance](P1.1-ACCEPTANCE.md). Plugin code receives scoped services rather than raw stores or filesystem paths. Artifact reads verify project/invocation ownership and actual bytes; snapshot dependencies are pinned to the invocation. The host owns GC and snapshot release.

Shutdown stops new admission, drains Gateway work and queued service operations, closes persistent resources, then releases the exclusive lock. Startup validation failures close acquired resources. A corrupt authoritative workspace fails closed rather than silently resetting project data. This is a trusted in-process, single-writer local host; it is not a third-party sandbox or distributed transaction system.

Patch protocol 1.3.0 now has JSON Schema coverage for scene, shot and animation operations. ProjectDocument remains 1.1.0; its animation-track schema explicitly requires `targetNodeId` and permits `enabled`, matching the TypeScript model. The existing Episode/CPU-cache renderer remains independent; Project Snapshot rendering is still P1.1-G.


### CI correction — Patch Schema strict array typing

After the self-contained keyframe reference fix, all 170 platform tests passed. The next CI step then failed because the Patch 1.2.0 conditional schema constrained `patches.items` without declaring `patches.type: array`, which Ajv strictTypes rejects. Added the missing array type. The validation script now compiles the Patch Schema independently in strict mode and rejects all external `$ref` dependencies, preventing both regressions.


## P1.1-G first Project Graph renderer slice

The first data-driven 2D render path is implemented in `src/renderers/remotion/project-render-model.ts` and `src/compositions/ProjectGraphComposition.tsx`. It selects the active scene/shot, traverses scene hierarchy and composes group transforms, renders text and basic geometric primitives, and samples supported position/rotation/scale/opacity tracks. Unsupported node and animation cases produce structured diagnostics. The existing Episode/CPU-cache composition remains separately registered and unchanged.

The `builtin.workspace` plugin now exposes executable `project.scene.create`, `graphics.2d.text.create`, `graphics.2d.shape.create`, `project.node.transform.set`, and `animation.keyframes.set` tools through the same scoped host/Registry/Gateway and Patch 1.3.0 boundary. A water-cycle Project Graph fixture is registered as a second Remotion composition and CI renders a 10-second 1080p/30fps MP4 with Project Schema and ffprobe validation. The host integration test creates and edits a project only through these public tools, then projects the resulting document into a render model.

This was the first vertical slice, not full P1.1-G completion. Subsequent snapshot render services, paths and charts are described below. Asset import, rich typography/layout, transitions, audio/captions, 3D and full visual acceptance remain open. See [P1.1-G first slice](P1.1-G-FIRST-SLICE.md).


## P1.1-G first vertical slice — CI verified

Commit `c826aa56c1c0d9c6ff977e97f0ae724d1e9310cb` passed [CI #43786811086](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43786811086): 175/175 platform tests, Project Patch/tool/plugin validation, a generic Project Graph MP4 render (H.264, 1920×1080, 30 FPS, 10.00s), and the separate legacy Episode/CPU-cache render with audio validation. The generic render uses the data-driven water-cycle fixture and the new Remotion Project Graph composition. The full P1.1 creative-loop gates remain open: tool-created project rendering through a retained snapshot, render Artifact services, second-topic reuse, visual review, 300-entry discovery scale and a real AI invocation trial.


## P1.1-G snapshot render services

render.preview and render.video are invocation-scoped Gateway tools. They accept only a project-owned immutable snapshot ID and bounded frame/range parameters; no filesystem path or arbitrary entrypoint is supplied by the AI. The host verifies snapshot ownership and canonical content hash, validates the frame range against the snapshot sequence, and delegates to the configured ProjectGraphRenderer adapter. The default local implementation uses Remotion's programmatic bundler/renderer to render a PNG still or H.264 MP4 from the same generic ProjectGraph composition.

Rendered bytes are size-checked and stored in the content-addressed ArtifactStore. The render receipt records the current snapshot ID/hash, source revision, frame/range, dimensions/FPS and renderer identity/version; provenance binds the invocation to project/run/call/tool. Identical bytes share a blob with immutable first-writer storage metadata, while each render result/execution record carries its own receipt. The host validates/retains the Artifact reference before completing the invocation. Access requires snapshot.read and artifact.write in the session, plugin and tool declarations. Snapshot ownership/hash and sequence bounds are enforced before renderer work begins.

The renderer is injectable through trusted host configuration for deterministic tests; AI tool input cannot choose or replace the renderer implementation. Trusted `renderWorker` configuration optionally selects a disposable Linux guardian/Node render process for the existing synchronous tools and B2 background jobs. The guardian adopts and reaps detached Chromium descendants; the parent verifies returned identity/hash/bounded bytes before publication and rejects late results after cancellation. The worker's callbacks/receipts are application evidence; B2 adds the client-facing job layer below. The default remains in process, with broader scheduling and aggregate resource quotas still pending. See [worker boundary and evidence](P1.2-WORKERS.md) and [P1.1-G render services](P1.1-G-RENDER-SERVICES.md). The original production-host PNG/MP4 path passed [CI #43788856539](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43788856539), including 177/177 platform tests and ffprobe checks on the host-produced video.

The [B1 render-job ledger](P1.2-B1-JOB-LEDGER.md) defines project-scoped submissions, immutable input hashes, owned transitions, throttled progress, a durable publication barrier and terminal/interrupted records. Its filesystem backend syncs atomic writes before acknowledgement and rejects continued use after uncertain persistence. Reopen preserves terminal evidence and marks every active record interrupted without replay. [B2](P1.2-B2-HOST-JOBS.md) opens this store in `openCreativeHost`, adds native session job APIs and opt-in protocol 1.1 methods, and enforces existing built-in render grants and exact versions. Jobs retain validated snapshots before client admission, use a bounded single runner outside the project queue, wait for renderer cleanup on accepted stops, and verify/retain actual Artifact bytes before success. Admission/publication and snapshot maintenance remain serialized; unresolved jobs protect their inputs. Close/revoke/plugin-transition behavior has integration tests. The existing execution ledger retains Gateway invocation evidence; native jobs use the job ledger without impersonating tool calls. [B3](P1.2-B3-CLI-LIFECYCLE.md) supplies the actual protocol-1.1 worker/CLI cancellation and interrupted-host recovery workflow, including guardian temporary-directory cleanup after parent death. Reopening still requires explicit verified ownership of abandoned locks; interrupted jobs are never automatically replayed. C expands scheduling and retention administration.
\n\n## Structured SVG Path capability\n\nThe built-in workspace plugin exposes `graphics.2d.path.create`. It accepts SVG path command data plus explicit dimensions, fill, stroke, stroke width and fill rule. The input is restricted to path command letters and numeric arguments; XML elements, attributes, CSS, URL references and script-bearing markup are rejected. The canonical Project Graph stores this as a `path` node with a `geometry` component. The Remotion adapter emits a native SVG `<path>` element inside a bounded SVG viewport and applies the same node transform/opacity composition as text and shapes. This keeps authoring data renderer-neutral and avoids generating topic-specific TSX or accepting arbitrary SVG documents.\n

## Data-driven chart capability

The built-in workspace plugin exposes `graphics.2d.chart.create` for bar and line charts. The tool accepts 2–24 labelled finite numeric values and explicit geometry/style settings, then commits a normal shape node whose geometry component stores the chart type and data. The Project Graph render projection validates the chart payload and produces a renderer-neutral chart element. The Remotion adapter draws axes, grid lines, labels, bars or line points from the data at render time. No chart-specific TSX composition or external charting runtime is required. Invalid chart data produces a structured diagnostic rather than a malformed frame.

The final `ProjectGraphFrame` dispatches chart elements to the reusable `ProjectChartSvg` drawing component. Regression checks cover that dispatch as well as actual host-rendered PNG/MP4 pixels, since a valid projected chart element can still be drawn incorrectly. [Chart notes](P1.1-G-CHARTS.md) describe signed/zero scaling, dense-label limits and targeted-edit evidence.
