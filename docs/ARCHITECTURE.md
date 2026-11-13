# Architecture

Last updated: 2026-11-13

## Product architecture

ScienceMotion AI is an agent-native creative framework for producing professional science explainers and other complex videos. The platform is designed to host hundreds of composable tools and multiple specialist engines without hard-coding tool implementations into the agent orchestration layer.

## Current phase status

- **P1.0 — Complete:** canonical renderer-neutral Project Graph v1.1, patch/revision lifecycle, prefabs, animation tracks, constraint/dependency validation, schema migration, filesystem snapshots, and automated acceptance tests.
- **P1.1 — Active:** agent-facing tool manifests, dynamic registry discovery, local execution gateway, and the first in-process plugin lifecycle.
- **P1.2 — Planned:** isolated workers, durable jobs, cancellation, progress, resource governance, and sandbox boundaries.
- **P0 media polish — Non-blocking:** the Remotion/TTS/MP4 CI baseline works; speech-aligned captions, richer audio mixing, long-form reference content, proxy rendering, and formal render manifests remain enhancements.

P1.0 acceptance evidence: [GitHub Actions #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025).

## Architecture boundaries

1. **Project model:** canonical renderer-neutral project and scene graph.
2. **Tool platform:** manifests, registry, discovery, gateway, plugins, and execution records.
3. **Agent orchestration:** planning, tool selection, composition, approval, and iteration.
4. **Worker execution:** isolated rendering, simulation, audio, asset, and sandbox workloads.
5. **Engine adapters:** Remotion, Three.js, Blender, Manim, FFmpeg, and future engines.
6. **Asset/artifact services:** stable references, hashes, provenance, licensing, and output storage.

## Canonical Project Graph

The Project Graph from P1.0 is the source of truth for creative work. It is independent of renderer-specific scene representations.

```text
Project
  ├─ Editorial package
  │   ├─ Research / sources / claims
  │   ├─ Script / narration / captions
  │   └─ Creative brief / style references
  ├─ Sequences
  │   ├─ Shots / tracks / clips
  │   └─ Scenes
  │       └─ Nodes / transforms / components
  │           ├─ Geometry / text / image / video
  │           ├─ Camera / light / environment
  │           ├─ Material / texture
  │           └─ Animation / constraints / simulation
  ├─ Prefabs / dependencies
  ├─ Assets
  └─ Revisions / snapshots
```

All project mutations go through versioned Patch operations. Patch batches apply to cloned project state and return a new project only when every operation succeeds. Repository commits compare the requested base revision with the current revision. The current repository and filesystem snapshot implementations are local single-process foundations.

## Agent Tool Platform

### Manifest and discovery

Each tool declares a stable namespaced ID, semantic version, description, typed input/output JSON Schemas, category, tags, capabilities, engine requirements, compatible Project Schema versions, lifecycle status, plugin ownership, permissions, cost, timeout, cancellation, idempotency, and concurrency hints.

The registry supports discovery by text, namespace, category, tags, capabilities, engine, and Project Schema compatibility. It supports pagination, deprecation filtering, and semantic-version selection.

### Gateway

The local gateway validates input and output schemas, checks permissions, propagates cooperative cancellation, enforces timeouts, and returns structured diagnostics and execution metadata. Tool implementations must honor AbortSignal for cooperative cancellation. Forceful termination and isolation of non-cooperative tools belong to P1.2 worker execution.

### Plugin lifecycle

The initial in-process plugin manager supports install, enable, disable, uninstall, dependency/version checks, health checks, and rollback if tool registration or health validation fails. Plugin manifests are separately versioned and CI-validated.

This implementation loads trusted plugin objects supplied by the host process. It is **not** a sandbox and does not dynamically execute arbitrary downloaded code. Untrusted third-party plugin isolation, signature verification, upgrade migrations, and remote distribution are future hardening work.

## Worker model

Worker classes are planned for rendering, simulation, assets, audio, and sandboxed code. Jobs will use versioned envelopes and artifact references and support progress, cancellation, safe retries, and resource limits. Worker isolation is a P1.2 deliverable.

## Engine adapters

- **Remotion:** 2D motion design, typography, diagrams, compositing, and video timelines.
- **Three.js:** procedural 3D scenes, cameras, materials, lights, and shaders.
- **Blender:** high-fidelity offline 3D, procedural geometry, rigging, rendering, and compositing.
- **Manim:** equations, plots, geometry, and mathematical derivations.
- **FFmpeg:** encoding, muxing, audio/video filters, and delivery formats.

Adapters declare capabilities and supported project schema versions. Unsupported features return explicit diagnostics or documented fallbacks.

## Asset and artifact model

Large binaries remain outside project JSON and are referenced by stable artifact IDs/URIs. Content hashes support integrity, deduplication, and caching. Assets retain source, provider, license, attribution, and transformation metadata.

## Reliability and security

Apply least-privilege permissions to tools and workers. Enforce CPU, memory, GPU, disk, network, and wall-time budgets. Treat tool inputs, assets, scripts, and model outputs as untrusted data. Record project/run/call IDs, tool versions, timings, retries, diagnostics, and artifact hashes.

## Engineering workflow

- Keep `main` releasable and CI-validated.
- Version project and tool contracts; add explicit migrations for breaking schema changes.
- Keep project model, registry, gateway, plugins, workers, providers, and renderer adapters behind explicit boundaries.
- Prefer composable tools with structured results over a monolithic generate-video endpoint.
- Mark capabilities complete only after automated tests and representative CI evidence.


## P1.1 execution governance — local implementation

- Added `ToolExecutionStore` and `InMemoryToolExecutionStore` for started/succeeded/failed invocation records, input SHA-256 hashes, results, diagnostics, timestamps, and duration.
- Gateway idempotency keys are scoped by project, tool ID, and tool version. Reusing a key with a different input hash returns a conflict; successful calls replay the stored result; failed keys are consumed rather than silently re-executed.
- Bounded retries (maximum five attempts) are available only for tools declaring idempotency and returning an explicitly retryable result.
- Per-tool `maxConcurrency` is enforced in the local process before asynchronous execution begins.
- Execution store is injected through an interface. The supplied in-memory implementation is suitable for tests and local development; durable shared storage and cross-process guarantees remain later platform work.
- Gateway cancellation is cooperative: tool implementations must observe the supplied AbortSignal. A caller cancellation test waits until the tool has started before aborting, so it verifies in-flight propagation rather than pre-start cancellation.


## P1.1-C artifact system — initial implementation

- Added renderer-neutral `ArtifactRecord` and `ArtifactStore` contracts for image, video, audio, model, texture, document, data, and other outputs.
- Artifact IDs use `sha256:<hex>`; URIs use `artifact://sha256/<hex>`. Records include media type, byte size, creation time, provenance (project/run/call/tool/plugin/source artifacts), metadata, license, and attribution.
- Added in-memory and filesystem content-addressed stores. The filesystem backend stores blobs by SHA-256 and metadata separately, stages writes before rename, deduplicates identical bytes, verifies hashes on read, and rejects malformed artifact IDs.
- Tool Gateway can receive an ArtifactStore and validates every returned artifact reference against stored ID, URI, media type, and optional content hash before accepting the result.
- Tests cover deterministic hashing, duplicate-byte deduplication, metadata/provenance lookup, byte isolation, filesystem persistence, deletion, path/ID validation, tamper detection, and gateway artifact-reference validation.

Current scope is local storage. Project asset-graph attachment, reference counting/garbage collection, remote object storage, signed URLs, and cross-worker artifact transfer are later integration work.


## P1.1-D artifact lifecycle — local implementation

- Added `ArtifactReference` and `ArtifactReferenceStore` contracts. References are stable/idempotent for the tuple (artifact ID, owner type, owner ID, role), allowing multiple projects or tool runs to share the same content-addressed blob.
- Added in-memory and filesystem reference stores. The filesystem implementation persists each reference as a separate atomic JSON record and validates reference IDs before resolving paths.
- Added `LocalArtifactLifecycleManager` for attach, detach, reverse lookup, project linking, and garbage collection.
- Project linking creates a normal P1.0 `ProjectAsset` entry containing Artifact URI, content hash, media type, size, license, and attribution, while keeping binary bytes outside Project JSON. The lifecycle reference is recorded against the project ID.
- Garbage collection preserves any artifact with one or more references and applies a configurable age grace period to unreferenced artifacts. Invalid timestamps are retained rather than collected. Local per-artifact operation serialization prevents attach/detach and GC from racing within one process.
- Tool Gateway can optionally receive the lifecycle manager and automatically attach successful output artifacts to the originating tool-run reference.
- Tests cover idempotent references, shared artifacts across projects, project asset linking, persistent reference lookup after manager restart, grace-period collection, missing artifact rejection, conflicting project asset IDs, and automatic tool-output retention.

The current lifecycle guarantees are local-process guarantees. Cross-process transactions, project asset unlink orchestration, reference repair/reconciliation, and scheduled retention policies are deferred to the durable worker/storage phase.
