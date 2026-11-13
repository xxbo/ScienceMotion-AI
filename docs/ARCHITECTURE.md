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
