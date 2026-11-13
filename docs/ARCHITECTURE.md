# Architecture

## Product architecture

ScienceMotion AI is an agent-native professional video creation framework. It must be able to host hundreds of creative tools and multiple specialist engines without requiring the AI orchestration core to know each tool implementation.

The platform is organized around six concerns:
1. **Project model:** canonical, renderer-neutral project and scene graph.
2. **Tool platform:** discoverable manifests, registry, gateway, plugin lifecycle, and execution trace.
3. **Agent orchestration:** planning, tool discovery, composition, approvals, and iterative feedback.
4. **Worker execution:** isolated render, simulation, audio, asset, and code-execution workers.
5. **Engine adapters:** Remotion, Three.js, Blender, Manim, FFmpeg, and future engines.
6. **Asset and artifact services:** durable references, content hashes, provenance, licenses, and render outputs.

## High-level flow

```text
Creative brief
  -> Agent plans work and discovers tools
  -> Tool registry returns manifests, schemas, examples, capabilities
  -> Tool gateway validates, authorizes, schedules and records calls
  -> Project/Scene Graph is updated through non-destructive patches
  -> Worker executes the requested capability through an engine adapter
  -> Structured result, diagnostics and artifact references return to agent
  -> Agent previews, inspects, revises, and re-renders
  -> Render manifest + final media
```

## Architecture principles

### Content and rendering are strictly decoupled
- Editorial meaning: research, claims, sources, narration, captions, creative brief.
- Creative intent: storyboard, shot purpose, scene semantics, visual direction.
- Project graph: objects, relationships, transforms, materials, cameras, lights, tracks, simulations.
- Render configuration: engine, quality settings, output profile, and capability requirements.

The renderer consumes an approved, versioned project snapshot. It must not call LLMs, invent editorial content, or mutate the source project. Multiple engines can consume the same project snapshot through adapters. Engine-specific extensions must be namespaced and capability-gated.

### Agent freedom with professional controls
- Expose both high-level creative helpers and low-level primitives.
- High-level templates are built on lower-level tools and remain optional.
- Agents dynamically discover tools and inspect schemas/examples; do not hard-code tool catalog knowledge into the orchestration layer.
- All operations return structured results, diagnostics, and artifact references.
- Expensive, destructive, or code-executing operations are governed by permissions and budgets.

### Scale through modular boundaries
Start with a **modular monolith for the control plane and isolated worker processes** for rendering and risky workloads. Do not prematurely split every subsystem into a network service. The boundaries must permit later horizontal scaling and remote workers without changing public tool contracts.

## Canonical project and scene graph

The project model is the source of truth for creative work. It is separate from any renderer's internal scene representation.

### Entity hierarchy

```text
Project
  ├─ Editorial Package
  │   ├─ Research / Sources / Claims
  │   ├─ Script / Narration / Captions
  │   └─ Creative Brief / Style References
  ├─ Sequences
  │   ├─ Shots / Tracks / Clips / Markers
  │   └─ Scenes
  │       └─ Scene Graph Nodes
  │           ├─ Geometry / Text / Image / Video
  │           ├─ Camera / Light / Environment
  │           ├─ Material / Texture
  │           ├─ Animation Tracks / Constraints
  │           └─ Simulation Components
  ├─ Asset Graph
  ├─ Tool Execution Graph
  ├─ Render Profiles / Render Manifests
  └─ Revision History / Snapshots
```

### Required model properties

- Stable IDs for projects, sequences, shots, scenes, nodes, components, tracks, assets, and tool calls.
- Parent-child relationships, references, reusable prefabs/components, and dependency graph.
- Non-destructive patch operations with optimistic concurrency/version checks.
- Explicit units, coordinate conventions, frame/time base, color space, and asset URI semantics.
- Schema versions and migration paths.
- Immutable render snapshots so a render is reproducible even while a working project evolves.
- Engine-neutral core components plus namespaced extension data for specialist features.

## Agent tool platform

### Tool manifest

Every tool manifest declares:
- Stable ID and semantic version.
- Name, description, examples, category, tags, and namespace.
- Typed input/output JSON Schemas.
- Capabilities and engine/provider requirements.
- Determinism, statefulness, cost, destructive behavior, timeout, cancellation support, and permissions.
- Output artifact types and expected diagnostics.
- Compatibility constraints and deprecation status.

### Registry and discovery

The registry supports:
- Search by natural-language intent, tags, category, namespace, capability, and engine.
- Manifest and schema retrieval before invocation.
- Version pinning, compatibility filtering, and deprecation notices.
- Plugin registration, health, enable/disable, dependency resolution, and unload.
- Pagination and compact tool descriptions so hundreds of tools do not overwhelm the agent context.

### Tool gateway

The gateway is the only supported execution path for agent-invoked tools. It owns:
- Input/output schema validation.
- Authentication, permissions, approval policy, quotas, and resource budgets.
- Timeout, cancellation, idempotency, retries, and concurrency control.
- Structured errors and diagnostics.
- Tool-call traces, metrics, and artifact persistence.
- Project revision checks and non-destructive state updates.

Tool implementations do not receive unrestricted access to project storage or the host environment.

### Tool namespaces

Initial namespaces:
- `project.*`: project, sequence, shot, scene, node, layer, track, timeline.
- `graphics.2d.*`: text, shape, path, SVG, mask, gradient, chart, diagram.
- `geometry.*`: primitive, mesh, transform, group, parenting, coordinate conversion.
- `animation.*`: keyframe, easing, path, interpolation, transition, constraint.
- `camera.*`, `lighting.*`, `materials.*`: cinematography and look development.
- `simulation.*`: particles, forces, springs, waves, rigid bodies, trajectories.
- `assets.*`: search, import, inspect, transform, provenance, licensing.
- `audio.*`: TTS, narration, captions, music, SFX, mixing, ducking.
- `compositing.*`: layers, blends, masks, keys, grading, effects.
- `render.*`: preview, still, proxy, final, cancel, status, manifest.
- `inspect.*`: frame, metadata, visual QA, audio QA, compare, diagnostics.
- `engine.<provider>.*`: explicit engine-specific advanced features.

The goal is a coherent catalogue that can grow to hundreds of tools, not a fixed hard-coded list.

## Execution and worker model

### Control plane
Owns project state, tool discovery, agent orchestration, authorization, job scheduling, execution metadata, and revision history.

### Worker classes
- **Render workers:** Remotion, Blender, Manim, Three.js/headless browser, FFmpeg.
- **Simulation workers:** numerical and physical simulation workloads.
- **Asset workers:** media import, transformation, thumbnails, model conversion, metadata.
- **Audio workers:** TTS, speech alignment, mixing, loudness and audio QA.
- **Sandbox workers:** custom scripts, shaders, procedural generation, and user/agent code.

Workers communicate through versioned job envelopes and artifact references. They are isolated so a crash or resource spike does not terminate the control plane. Jobs support progress, cancellation, retries where safe, and resumable execution.

### Scaling strategy
1. Local development: in-process registry/gateway plus child-process workers.
2. Single-host production: durable job queue and isolated worker pools.
3. Distributed production: remote workers, object storage, scheduling, quotas, and horizontal scaling.

Keep public tool and project contracts stable across all three stages.

## Engine adapter layer

Adapters translate portable project components and tool semantics into engine-specific operations.

- **Remotion:** 2D motion graphics, typography, diagrams, compositing, and video timelines.
- **Three.js:** interactive and procedural 3D scenes, camera, materials, lighting, and shader-driven effects.
- **Blender:** high-quality offline 3D, procedural geometry, rigging, animation, rendering, and compositing.
- **Manim:** equations, plots, geometry, and mathematical derivations.
- **FFmpeg:** media encoding, muxing, audio/video filters, and delivery formats.

Adapters declare capabilities and supported schema versions. Unsupported features must trigger an explicit diagnostic or documented fallback, never silent semantic loss.

## Asset and artifact model

- Store large binaries outside project JSON; project files reference stable artifact IDs/URIs.
- Use content hashes for deduplication, cache keys, and reproducibility.
- Track source, provider, license, attribution, creation parameters, and transformations.
- Return structured artifact references from tools rather than large inline binary payloads.
- Preserve render manifests, thumbnails, logs, and QA reports as addressable artifacts.

## Safety, reliability, and observability

- Apply least-privilege permissions to tools and workers.
- Enforce CPU, memory, GPU, disk, network, and wall-time budgets.
- Require explicit approval for destructive changes, external publishing, or expensive jobs according to policy.
- Treat tool inputs, assets, scripts, and model outputs as untrusted data.
- Log project/run/call IDs, tool versions, timings, retries, diagnostics, and artifact hashes.
- Use snapshots, rollback, and optimistic concurrency for project mutations.

## Current implementation and migration

Existing assets remain useful:
- Remotion is the first proven video renderer.
- React/TypeScript is the platform/control-plane language.
- Episode JSON and its schema are the first editorial interchange format.
- The initial renderer contract and tool manifest/gateway prototype are starting points.
- Edge TTS is a replaceable voice adapter.
- SVG storyboard rendering is a lightweight independent output.
- The CPU-cache episode is a reference fixture.

These are foundations, not the final architecture. Incrementally evolve the episode format into the canonical project model; do not discard working renderers or force every subsystem into one package.

## Implementation stages

1. Project/scene graph schemas and patch model.
2. Tool manifest, discovery, gateway, plugin lifecycle, and execution records.
3. Worker/job envelope and isolated process execution.
4. Initial composable project, geometry, graphics, animation, timeline, asset, audio, preview, and inspection tools.
5. Agent iteration loop with preview/inspect/patch/re-render.
6. Specialist engine adapters and professional tool depth.
7. Distributed execution and production operations when justified.


## Project Schema v1.0.0 — initial implementation

The first canonical project model is defined in:
- `schemas/project.schema.json`
- `src/contracts/project.ts`
- `projects/cpu-cache/project.json`

It models project metadata, editorial linkage, sequences, scenes, scene nodes, transforms, typed component slots, tracks, shots, clips, assets, and revision records. Coordinate system, units, timebase, and color space are explicit project-level settings.

Validation is performed by `scripts/validate-project.mjs` and checks:
- JSON Schema conformance.
- Unique IDs within each entity collection.
- Scene root, parent/child, shot/scene, sequence/shot, track/clip, clip/asset, and revision references.
- Cyclic node hierarchy and parent/child consistency.

This is the first project graph contract, not yet the complete final model. Constraints, simulation-specific typed components, reusable prefabs, dependency graph, patch execution, optimistic concurrency, snapshots, and schema migrations remain planned. Component payloads are currently extensible JSON objects; specialist component schemas will be introduced by capability/plugin namespaces.


## Project patch model — initial implementation

- `schemas/project-patch.schema.json` defines versioned patch documents with project ID and required base revision ID.
- `src/contracts/project-patch.ts` defines add-node, update-node, remove-node, and reparent-node operations.
- `src/platform/project-patches.ts` applies a patch batch to a cloned project, checks revision conflicts, prevents node ID changes, requires explicit recursive deletion, validates hierarchy cycles, and appends a new revision record.
- A failed patch throws before returning a new project; the source project object is not mutated.

This first patch engine is an in-memory domain primitive. Persistent snapshots, full project-wide optimistic concurrency, operation-level schema validation at the gateway, and comprehensive automated unit tests remain outstanding.


## Project Schema v1.1.0, migrations, snapshots, and patch tests

The project contract has been versioned to v1.1.0. It adds:
- Prefab definitions and node prefab references.
- Scene constraints with typed constraint kinds and source/target node references.
- Project dependency edges between nodes, scenes, shots, assets, prefabs, and clips.
- Additional component kinds for physics, rigs, environments, post-processing, and custom extensions.
- JSON Schema definitions for keyframes, animation tracks, simulation settings, and physics body parameters.

Migration and snapshot utilities:
- `src/platform/project-migrations.ts` performs an additive v1.0.0 → v1.1.0 migration without mutating the input.
- `src/platform/project-snapshots.ts` provides canonical JSON serialization, SHA-256 content hashes, an in-memory snapshot store, integrity verification, and restore.
- Snapshots are currently in-memory reference implementations; durable storage is a later worker/platform concern.

Patch and test improvements:
- Node removal now cleans constraints and node-related dependency edges.
- `src/platform/project-platform.test.ts` covers add, reparent, recursive removal, stale revision rejection, cycle rejection, migration, and snapshot restoration.
- CI runs the project platform unit tests and validates project, patch, and episode documents.

Remaining P1.0 work includes durable snapshot persistence, optimistic concurrency at a persistent repository boundary, more complete scene/sequence membership rules, and broader property-based tests. The current snapshot store is not yet a production persistence layer.


### CI correction — Project Patch Schema v1.1.0

The first CI run after the Project Schema v1.1.0 migration failed at `validate:project-patch`, not in TypeScript or the project graph tests. The validator's synthetic patch fixture still declared `schemaVersion: 1.0.0` while the patch contract had been advanced to `1.1.0`. Updated the fixture to v1.1.0 in commit `d2360869bc8c213a82906fc52eb44a80a0336c0b`. The previous run had already passed typecheck, episode validation, project validation, and all six platform tests. The corrected full pipeline is running separately; success is pending its result.


P1.0 follow-up implementation (2026-11-13):
- Added `FileSystemSnapshotStore` as a durable local backend implementing an asynchronous persistence contract. Snapshot writes use a temporary file and rename; restore verifies SHA-256 integrity. The in-memory store remains useful for fast unit tests.
- Added fast-check property-based coverage for arbitrary node transforms, asserting patch application does not mutate the source project.
- Strengthened patch operations to reject parenting across scene boundaries.
- Strengthened project semantic validation: every root belongs to exactly one scene, roots cannot have parents, and parent/child links must be reciprocal with no duplicate child references.
- Added filesystem snapshot tests for persistence, listing, restoration, path traversal rejection, and tamper detection.


## P1.0 follow-up: prefab instances and reference project migration

- `src/platform/prefabs.ts` implements deterministic prefab subtree cloning with instance-prefixed IDs, remapped parent/child references, optional naming suffix, and root position offset. It clones the project before mutation and returns created node IDs.
- Node deletion now removes prefab root references as well as constraints and dependency edges.
- Reparent operations report both old and new parent nodes as changed.
- The CPU-cache project fixture now contains all seven episode scenes and shots, a narration clip linked to its audio track, a reusable memory-module prefab, and explicit dependency edges.
- Unit tests cover prefab instance immutability, hierarchy remapping, cross-scene parenting rejection, prefab cleanup, and changed-node reporting.

The filesystem snapshot backend is the first durable local adapter. Database/object-storage implementations should follow the same asynchronous persistence contract without changing project or snapshot semantics.


### CI correction — recursive removal test fixture

The latest P1.0 CI run passed TypeScript, episode validation, project validation, and the first two patch tests, then failed in `recursive removal cleans constraints and dependency edges`. The test incorrectly expected the entire dependency collection to become empty, although the migrated CPU-cache project already contains unrelated dependency edges. The implementation correctly removes only edges referencing deleted nodes. Updated the assertion to preserve the pre-existing constraint/dependency counts and explicitly verify the test edge is removed. Fix commit: `1dc45f6b26c0ec8ae0cb3d9e7dd0603f0e2d62f7`.
