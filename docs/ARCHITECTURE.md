# Architecture

Last updated: 2026-11-14

## Direction and current boundaries

ScienceMotion AI is an agent-facing science-video framework intended to host hundreds of composable creative tools. The platform separates editorial meaning, project state, tool execution, artifacts and specialist renderers.

P1.0 is the accepted local project foundation. P1.1 is active. The current control plane is in-process; isolated workers are P1.2. See [Development Plan](PLAN.md) for stage ownership and [P1.1-E](P1.1-E.md) for plugin version semantics and acceptance evidence.

## Project and rendering

Project Schema v1.1 models sequences, scenes, nodes, transforms, component payloads, shots/tracks/clips, assets, prefabs, animation tracks, constraints, dependency edges and revisions. Editorial content remains independently represented by the Episode package.

Node Patch batches clone project state, check revisions and return a new document on success. An in-memory repository supplies single-process compare-and-swap. Memory and filesystem snapshots support content hashing and restore. These mechanisms do not provide a distributed database transaction or a physics solver.

The Remotion video pipeline and SVG storyboard currently consume the Episode package. A seven-shot Project Graph fixture is validated separately. Full generic Project Graph rendering, specialist component execution and the agent visual iteration loop are later integration work.

## Tool platform

Tool manifests declare namespaced IDs, stable versions, schemas, descriptions, categories/tags, capabilities, engines, project compatibility, cost, permissions and execution hints. Registry discovery filters these fields and supports pagination. The sample geometry tool/plugin manifests are catalogue fixtures, not proof of an implemented creative tool suite.

The local Gateway validates input/output and configured artifact references, checks a supplied permission allow-list, passes cooperative cancellation, limits concurrent executions and retries explicitly retryable results for tools declaring idempotency. Execution records and successful replay currently use an in-memory store. Atomic concurrent idempotency reservations, durable history, full budgets and approval policy remain open.

Timeout/cancellation stops waiting or signals cooperative code; it is not process isolation. Long-running or non-cooperative engines will run behind worker boundaries.

## Plugin versions and publication

`InMemoryPluginManager` uses a structural registry interface compatible with the existing registry. It installs multiple versions per plugin ID while publishing at most one active version for that ID. Installed metadata is copied/frozen. Installing a version never automatically switches live tools.

Activation checks version pins, active dependencies, enabled dependents, reachable dependency cycles, plugin/tool Project Schema compatibility and candidate health. Old registrations stay available during asynchronous health checks. Registration replacement and rollback are synchronous; candidate registration failure restores old registrations. Lifecycle mutations during a transition return `PLUGIN_BUSY`.

Pinning and version-lock import/export preserve exact choices. Import validates the complete lock before changing pins; it does not download/install/activate code. Explicit rollback uses the same dependency and compatibility checks as activation. Registry rollback cannot undo external side effects; health checks must be read-only. Already-started invocations may finish with the old implementation.

Supported dependency ranges are a deliberately bounded stable-version subset: exact, `*`, caret and tilde. Prereleases, compound ranges, automatic dependency solving, atomic multi-plugin upgrades, signature checking and remote distribution remain separate work. Plugins are trusted host-supplied objects, not sandboxed extensions.

## Artifacts and lifecycle

Artifacts use `sha256:<hex>` IDs and `artifact://sha256/<hex>` URIs. Large binaries stay outside Project JSON. Memory/filesystem stores provide deduplication, metadata, provenance and read-time hash verification.

Reference records identify artifact, owner and role. The lifecycle manager supports attach/detach, project asset linking/unlinking, reference reconciliation and grace-period garbage collection. Tool output references can be retained by Gateway. ProjectAsset stores URI/hash and metadata rather than binary content.

Current locking is per lifecycle-manager instance. Hosts must route related mutations through that instance; direct low-level deletion bypasses lifecycle checks. Project document persistence and reference updates are not one atomic transaction. Reference reconciliation and retention still need cross-process, snapshot and failure-path hardening before shared-worker deployment. Scheduled collection and remote object storage are not implemented by the local store.

## Specialist engines and workers

Remotion is the working video engine. The intended adapters include Three.js for procedural real-time 3D, Blender for offline 3D/compositing, Manim for mathematical animation and FFmpeg for media processing. Future adapters declare supported features and surface incompatibilities instead of silently losing meaning.

The target flow is:

```text
Agent -> discovery/manifest -> gateway -> tool
                                 |        |
                              records  Project Graph / artifacts
                                          |
                              isolated engine worker -> preview/final media
```

Worker job envelopes, process isolation, durable queues, resource budgets and remote artifact transfer belong to P1.2/P4. A generic automated preview/inspect/repair loop remains P1.4 work.

## Documentation and verification

P1.0 acceptance: [CI #43390347025](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43390347025). The P1.1-D baseline passed [CI #43405266507](https://github.com/xxbo/ScienceMotion-AI/actions/runs/43405266507).

Plugin version tests cover both the domain manager and the real Registry/Gateway. Manifest and lock schemas are exercised alongside existing platform tests. A documentation identity test guards README, PLAN and ARCHITECTURE against accidental replacement with source code or each other. New capabilities are committed with their tests and scoped documentation; a successful render does not by itself prove every data-model or concurrency guarantee.
