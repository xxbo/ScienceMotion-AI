# ScienceMotion AI — Platform Vision

Last updated: 2026-11-14

## Product definition

ScienceMotion AI is a professional, extensible science-video creation framework for AI agents. Agents discover typed tools, compose original graphics and animation, preview results, revise selected elements and render deliverables. The platform should grow to hundreds of tools without hard-coding individual tools into agent orchestration.

The product has two equally important outcomes: extensible infrastructure and executable creative capability. Catalogue size, management features and a single polished demo are each insufficient on their own. Templates and high-level workflows are optional accelerators, never the creative ceiling.

## Immediate objective after the architecture review

Reuse the existing Project Graph, Registry, Gateway, Plugin Manager, Artifact Store and Remotion/TTS foundation. Move the next development focus from adding management features to proving a small, real creative path:

```text
Approved editorial package
  -> agent planning and typed tool calls
  -> versioned Project Graph mutations
  -> immutable project snapshot
  -> generic 2D renderer adapter
  -> preview / targeted revision / final video
```

Deliver approximately ten executable tools, a bounded generic 2D rendering subset, two short explainers on different topics, and a catalogue-scale test using 300 synthetic manifests. These are planned P1.1 acceptance targets, not claims about current capabilities. Detailed gates are defined in [P1.1 Acceptance](P1.1-ACCEPTANCE.md).

A scripted invocation sequence first provides reproducible regression evidence; a real AI invocation trial then demonstrates discovery and schema-guided use of the same tools. A full autonomous visual critique agent remains a later milestone.

## Non-negotiable boundaries

1. **Content and rendering are independent.** Research, claims, narration and captions belong upstream. Renderers consume approved data and do not call language models, invent explanations or rewrite meaning. Topic-specific text must not be embedded in a generic renderer.
2. **One creative project model.** All creative tools use the canonical Project Graph and revisioned editing boundary. Editorial data remains separate and is referenced or compiled into approved render inputs; avoid conflicting copies of scene/timeline state.
3. **Freedom through composition.** Expose low-level primitives alongside high-level helpers. A new topic must not require a new topic-specific TSX scene or a privileged template.
4. **Stable, inspectable execution.** Typed manifests, explicit capabilities, version pins, input validation, permission policy, execution evidence and artifact provenance make tool composition reliable.
5. **Local revision and reproducibility.** Objects, tracks and assets retain stable identities. Snapshots preserve the dependencies needed to restore and render a project. Unsupported features return diagnostics rather than silently changing semantics.
6. **Stage deployment complexity.** Start with a modular local control plane and trusted plugins, then isolated single-host workers, then distributed storage/execution when needed.

## What the platform ultimately provides

| Domain | Intended capability |
| --- | --- |
| Project editing | Scenes, nodes, timelines, assets, revisions, snapshots and non-destructive operations |
| Tool platform | Discovery, schemas/examples, plugins, versions, controlled execution and traces |
| Creative primitives | Text, diagrams, paths, charts, geometry, transforms, materials, cameras and lights |
| Animation and simulation | Keyframes, easing, transitions, mathematical/scientific visualization and specialist simulations |
| Media and assets | Import/generation, narration, captions, audio mixing, provenance and licensing |
| Rendering and feedback | Engine adapters, previews, diagnostics, targeted repair, final exports and manifests |
| Workers | Isolation, job progress, cancellation, resource limits and later remote execution |

Remotion is the first working video engine. Three.js, Blender, Manim, FFmpeg and provider integrations remain specialist extension directions, not simultaneous prerequisites for the first creative loop.

## Meaning of professional quality

Technical validity, creative correctness and presentation quality are separate evidence tracks. In addition to decodable video/audio, verify that edits affect the intended visuals, approved content is preserved, unsupported animation is diagnosed, and representative frames avoid accidental clipping, unreadable labels and unintended overlap. Record human review of representative frames and animation timing; metadata checks alone do not establish visual quality.

Advanced cinematography, full 3D/physics, rich audio mixing and polished long-form episodes remain later depth work. The first 2D slice must be useful and inspectable without being misrepresented as that final quality level.

## Guardrails against scope drift

Every proposed task must strengthen an acceptance gate or enable a demonstrated creative operation. Reliability fixes required by that path take priority; speculative infrastructure does not. Use acceptance evidence instead of unsupported percentage-complete estimates.

Report separately: implemented executable tools, catalogue-only fixtures, synthetic scale-test entries, supported render capabilities and visually reviewed outputs. The CPU-cache explainer remains a reusable fixture, not the product boundary. A second topic must use the same public contracts.

Until the first creative loop is accepted, defer a plugin marketplace, remote package distribution/signatures, automatic dependency solving, atomic multi-plugin upgrade plans, distributed transactions, remote object storage and elaborate GC scheduling. Local data integrity and safe execution remain mandatory.

## Document ownership

This document owns product goals and durable principles. [Development Plan](PLAN.md) owns sequencing and status; [Architecture](ARCHITECTURE.md) distinguishes current implementation from target design; [P1.1 Acceptance](P1.1-ACCEPTANCE.md) owns measurable exit gates. Update these together when a milestone boundary changes.
