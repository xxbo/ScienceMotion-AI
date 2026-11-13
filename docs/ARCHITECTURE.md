# Architecture

Last updated: 2026-11-13

## Product architecture

ScienceMotion AI is an agent-native creative framework for producing professional science explainers and other complex videos. Its primary architecture goal is to host hundreds of composable creative tools and multiple specialist engines without hard-coding each tool into the agent orchestration layer.

The platform has six major boundaries:

1. **Project model:** canonical, renderer-neutral project and scene graph.
2. **Tool platform:** manifests, registry, discovery, gateway, plugins, and execution records.
3. **Agent orchestration:** planning, tool selection, composition, approval, and iteration.
4. **Worker execution:** isolated rendering, simulation, audio, asset, and sandbox workloads.
5. **Engine adapters:** Remotion, Three.js, Blender, Manim, FFmpeg, and future engines.
6. **Asset/artifact services:** stable references, hashes, provenance, licensing, and output storage.

## Current implementation status

### Completed: P1.0 canonical project model and scene graph

P1.0 is accepted on main commit `9cbcf933f3654e94699f199b85a4c0f7bbae1d12`.

Acceptance evidence: [GitHub Actions run #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025) completed successfully. It passed:
- TypeScript type checking.
- Episode, Project, and Project Patch schema validation.
- Platform unit tests.
- Independent SVG storyboard rendering.
- Mandarin TTS environment setup.
- Remotion MP4 rendering.
- MP4 metadata and audio-stream validation.
- Render artifact upload.

The CPU-cache reference project passed the canonical project validator.

P1.0 delivers:
- Project Schema v1.1.0 and TypeScript contracts for projects, sequences, shots, scenes, nodes, transforms, components, tracks, animation tracks, clips, assets, prefabs, constraints, dependencies, and revisions.
- Semantic validation for identifiers, scene hierarchy, sequence/shot membership, timing, clips, prefab roots, constraints, dependencies, and animation references.
- Versioned non-destructive patch operations for adding, updating, removing, and reparenting nodes.
- Atomic patch application against cloned project state, base-revision checks, duplicate revision rejection, and an in-memory compare-and-swap repository.
- Prefab subtree instantiation with internal node, constraint, dependency, and animation-reference remapping.
- Renderer-neutral animation track validation and deterministic scalar/vector sampling for supported interpolation modes.
- Constraint semantic validation. This is validation only; it is not a physics or constraint solver.
- Schema migration from Project v1.0.0 to v1.1.0.
- Canonical JSON hashing, in-memory snapshots, and a filesystem snapshot backend with SHA-256 integrity verification and restore.
- Unit and property-based tests, including patch atomicity, repository concurrency behavior, prefab boundaries, migration, and snapshot lifecycle.

P1.0 intentionally does not include:
- A physical constraint solver or full simulation runtime.
- Distributed database transactions or multi-process compare-and-swap.
- Remote object storage or a production distributed worker fleet.
- A complete visual editor or the full AI preview/inspect/repair loop.

These are future engine, worker, and platform capabilities, not unfinished P1.0 requirements.

### Existing media foundation (P0)

The repository also retains a working Remotion-based 1080p render pipeline, Chinese TTS integration, renderer-neutral episode package, independent SVG storyboard output, and CI validation. The accepted CI run above rendered an MP4 and validated its metadata/audio stream.

Caption-to-speech alignment, richer music/SFX mixing, a polished 2–3 minute reference episode, proxy rendering, and a formal render manifest remain media-quality enhancements. They do not block P1.1 platform work.

### P1.1 starting point

An initial tool manifest schema, TypeScript contracts, in-memory registry, and local schema-validating gateway prototype already exist. They are scaffolding only. P1.1 will harden and extend them with namespaces, capability discovery, version policy, plugin lifecycle, cancellation, idempotency, retries, execution records, artifact references, and governance.

## Core data and execution flow

```text
Creative brief
  -> Agent plans and discovers tools
  -> Registry returns manifests, schemas, examples, and capabilities
  -> Gateway validates, authorizes, and records calls
  -> Tools modify the canonical Project Graph through versioned operations
  -> Workers execute rendering, simulation, audio, or asset jobs
  -> Structured results, diagnostics, and artifact references return
  -> Agent previews, inspects, revises, and re-renders
  -> Render manifest and final media
```

## Architectural principles

### Renderer-neutral project data

Editorial meaning, creative intent, project graph, asset graph, tool execution records, and render configuration are separate concerns. Renderers consume approved project snapshots; they do not call language models or mutate editorial content. Engine-specific features are namespaced and capability-gated.

### Agent freedom with professional controls

Expose both high-level creative helpers and low-level primitives. Templates are optional accelerators. Agents discover tools and schemas dynamically. Every tool returns structured results, diagnostics, and artifact references. Expensive, destructive, or code-executing operations are governed by permissions and resource budgets.

### Modular control plane and isolated workers

Start with a modular monolith for project state, discovery, authorization, and orchestration. Run renderers and risky workloads in isolated worker processes. Preserve stable contracts so workers can later move to remote pools without changing the agent-facing tool API.

## Canonical Project Graph

The Project Graph is the source of truth for creative work and is independent of renderer-specific scene representations.

```text
Project
  ├─ Editorial package
  │   ├─ Research / sources / claims
  │   ├─ Script / narration / captions
  │   └─ Creative brief / style references
  ├─ Sequences
  │   ├─ Shots / tracks / clips
  │   └─ Scenes
  │       └─ Scene graph nodes
  │           ├─ Geometry / text / image / video
  │           ├─ Camera / light / environment
  │           ├─ Material / texture
  │           ├─ Animation tracks / constraints
  │           └─ Simulation components
  ├─ Prefabs / dependencies
  ├─ Asset graph
  ├─ Revisions / snapshots
  └─ Render profiles / manifests
```

The v1.1 model defines stable IDs, parent/child relationships, scene roots, coordinate systems, units, timebase, color space, component extension points, animation tracks, prefab roots, constraints, dependencies, assets, and revisions.

Project mutations use versioned Patch documents. Patch batches are applied to a cloned document and return a new project only after all operations succeed. Repository commits compare the supplied base revision with the current revision. The current repository implementation is in-memory and single-process.

## Tool platform contract

Every tool manifest declares:
- Stable ID and semantic version.
- Name, description, examples, namespace, and category.
- Typed input/output JSON Schemas.
- Capabilities and engine/provider requirements.
- Determinism, statefulness, cost, destructive behavior, timeout, cancellation, and permissions.
- Output artifact types and diagnostics.

The registry provides search, manifest/schema retrieval, version selection, capability filtering, and plugin lifecycle. The gateway is the only supported execution path and owns validation, permissions, quotas, cancellation, retries, traces, and artifact persistence.

## Worker model

Worker classes are expected for rendering, simulation, assets, audio, and sandboxed code. Jobs use versioned envelopes and artifact references. They report progress and diagnostics and support cancellation and safe retry. Worker isolation is a P1.2 deliverable; it is not represented as complete by the current local registry prototype.

## Engine adapters

- **Remotion:** 2D motion design, typography, diagrams, compositing, and video timelines.
- **Three.js:** procedural and interactive 3D scenes, cameras, materials, lights, and shaders.
- **Blender:** high-fidelity offline 3D, procedural geometry, rigging, rendering, and compositing.
- **Manim:** equations, plots, geometry, and mathematical derivations.
- **FFmpeg:** media encoding, muxing, audio/video filters, and delivery formats.

Adapters declare capabilities and supported schema versions. Unsupported features produce explicit diagnostics or documented fallbacks rather than silent semantic loss.

## Asset and artifact model

Large binaries stay outside project JSON and are referenced by stable artifact IDs/URIs. Content hashes support integrity, deduplication, and cache keys. Provenance, licenses, attribution, provider, creation parameters, and transformations travel with assets. Tools return structured artifact references rather than large inline binary payloads.

## Reliability and security

Apply least-privilege permissions to tools and workers. Enforce CPU, memory, GPU, disk, network, and wall-time budgets. Treat tool inputs, assets, scripts, and model outputs as untrusted data. Record project/run/call IDs, tool versions, timings, retries, diagnostics, and artifact hashes. Use snapshots, rollback, and revision checks for project mutations.

## Engineering workflow

- Keep `main` releasable and CI-validated.
- Version schemas and tool contracts; add explicit migrations for breaking project-format changes.
- Keep project model, tool runtime, providers, workers, and renderer adapters behind explicit boundaries.
- Prefer composable tools with structured results over a monolithic generate-video endpoint.
- Inspect representative outputs and CI evidence before marking a phase complete.
