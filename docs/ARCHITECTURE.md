# Architecture

## Core architectural rule: content is not a renderer

ScienceMotion AI is designed around a strict boundary between **what the video says** and **how the video is drawn**.

Content generation produces an approved, versioned, renderer-neutral episode package. Rendering consumes that package and produces frames/audio/video. Neither side imports the implementation of the other.

### Ownership boundaries

| Concern | Content generation | Rendering |
|---|---|---|
| Research, claims, sources | Owns | Reads references for provenance only |
| Narration and editorial wording | Owns | Displays/plays supplied content |
| Shot order and semantic intent | Owns | Executes supplied order |
| Scene meaning and data | Owns typed scene intent | Maps intent to visual components |
| Layout, animation, camera, typography | No renderer-specific decisions | Owns |
| Frame rendering and encoding | No | Owns |
| TTS text and voice direction | Owns text/voice intent | Audio adapter synthesizes and mixes |
| LLM calls | Owns | Never |
| Renderer libraries | Never | Owns |

## Pipeline

```text
Topic
  -> Research package (claims, sources, caveats)
  -> Script (narration + timing intent)
  -> Storyboard (ordered shots + semantic scene intent)
  -> Versioned Episode Package (JSON + JSON Schema)
       |                    |                    |
       v                    v                    v
   Remotion 2D          Three.js 3D           Manim math
       |                    |                    |
       +--------------------+--------------------+
                            v
                 Audio/subtitle composition
                            v
                     MP4 + quality report
```

The content package is the stable interface. A renderer may implement only a subset of scene primitives; it must declare capabilities and either use a documented fallback or report an explicit unsupported feature. It must not silently alter scientific meaning.

## Episode package contract (planned)

The contract is versioned independently from application releases. Initial format: JSON, validated by JSON Schema and mirrored by TypeScript types.

Top-level fields:
- `schemaVersion`: explicit semantic contract version.
- `episode`: stable ID, title, language, audience, duration intent, and output profile intent.
- `sources`: stable source ID, URL, publisher, publication date, retrieval date, and attribution/license metadata.
- `claims`: stable claim ID, statement, supporting source IDs, confidence, caveats, and optional numeric values with units.
- `narration`: stable segment ID, text, voice direction, timing intent, and claim IDs.
- `shots`: stable shot ID, narration segment IDs, duration intent, transition intent, and ordered scene intents.
- `assets`: stable asset ID, URI or content hash, media type, license/attribution, and optional dimensions/duration.
- `audioCues`: stable cue ID, type, asset reference or generated voice segment, start/duration intent, gain, and ducking intent.
- `captions`: stable caption ID, narration segment reference, text, and optional measured start/end times.

Stable IDs allow a single shot or narration segment to be regenerated without invalidating unrelated approved work.

## Renderer adapter interface (planned)

A renderer adapter:
1. Declares its ID, version, supported schema versions, and scene primitive capabilities.
2. Validates package compatibility before rendering.
3. Maps scene intent to renderer-specific components.
4. Receives output settings separately from editorial content.
5. Emits a render manifest and structured diagnostics.
6. Never calls an LLM or edits the source episode package.

Candidate adapters:
- Remotion adapter: 2D motion graphics, titles, diagrams, subtitles, and compositing.
- Three.js adapter: spatial and 3D scenes.
- Manim adapter: equations, plots, and mathematical derivations.

The first implementation may render multiple scene types inside one Remotion adapter. The contract must remain renderer-neutral. The SVG storyboard script is an independent package consumer used to verify that episode content can produce a second visual artifact without loading Remotion; it is not yet a second MP4 renderer.

## Initial repository boundaries

- `apps/studio`: authoring and review UI. It should edit episode packages, not embed generation or rendering logic.
- `schemas/episode.schema.json` and `src/contracts/episode.ts`: versioned JSON Schema and TypeScript contract.
- `src/contracts/renderer.ts`: renderer adapter and capability contract.
- `src/contracts/agent-tool.ts`: agent-facing tool manifest, registry, gateway, and result contracts.
- `src/platform/tool-registry.ts`: initial in-memory registry and schema-validating local invocation gateway.
- `episodes/`: renderer-neutral episode packages.
- `scripts/render-storyboard-svg.mjs`: first independent non-Remotion output adapter (SVG storyboard).
- `packages/ai-director`: provider-independent research/script/storyboard orchestration. It depends on episode-schema, not on renderers.
- `packages/renderer-core`: adapter interface, capability model, render manifest, and shared validation.
- `packages/renderer-remotion`: Remotion implementation and 2D scene components.
- `packages/renderer-three`: Three.js implementation.
- `packages/renderer-manim`: Manim process adapter and asset import.
- `packages/scene-library`: reusable renderer-neutral scene intents and templates.
- `services/voice`: replaceable TTS providers, speech metadata, and audio alignment.
- `examples`: source episode packages and reproducible render examples.
- `docs`: product, technical, and production decisions.

Extract modules incrementally when working functionality exists. Do not create empty package shells solely to imitate the target architecture.

## Dependency direction

Allowed:
- ai-director -> episode-schema
- studio -> episode-schema, ai-director API, renderer API
- renderer adapters -> episode-schema, renderer-core
- voice service -> narration/episode schema

Forbidden:
- ai-director -> Remotion, React rendering internals, Three.js, Manim, FFmpeg
- renderer adapters -> LLM providers or editorial generation
- episode-schema -> any provider or renderer package
- renderer adapter mutating approved source episode packages

## Rendering model

Remotion evaluates a React composition at a specific frame. Animation values must be derived from the current frame and composition configuration, not wall-clock time. This makes output deterministic and allows the renderer to seek directly to any frame.

Default master format:
- 1920×1080
- 30 FPS
- H.264 MP4
- AAC audio when an audio track exists

Vertical and other platform formats should be output profiles, not separate implementations or changes to editorial content.

## Scientific correctness

Visuals must not silently imply measured or universal values. Label illustrative scales and simulations. Keep units explicit. For physical simulations, document assumptions, coordinate systems, and parameter ranges. For sourced factual statements, preserve source references through claims, narration, and shot data. Rendering must preserve these references in its render manifest.

## Decoupling acceptance tests

- Validate an episode package without importing a rendering library or launching a browser.
- Render the same package using two renderer adapters or two independent visual themes.
- Assert that rendering does not mutate the package (content hash and semantic fields unchanged).
- Test schema-version compatibility and explicit failure for unsupported versions/features.
- Run AI-director unit tests in an environment without Remotion, Chromium, or FFmpeg.


## Platform architecture: agent-first creative tooling

ScienceMotion is an AI-agent-facing creative platform. The agent should be able to discover and invoke many small composable tools, not merely submit a prompt to a fixed template generator.

### Tool system layers

1. **Tool catalog:** manifests describing tool ID/version, purpose, examples, input/output JSON Schemas, categories, capabilities, engine requirements, and execution metadata.
2. **Discovery service:** search tools by intent, capability, category, engine, or cost; retrieve full schema and examples before invocation.
3. **Tool gateway:** validates inputs/outputs, checks permissions and budgets, handles cancellation/timeouts, records execution traces, and persists artifacts.
4. **Tool implementations:** focused operations for scene graph, graphics, animation, assets, simulation, audio, editing, preview, and rendering.
5. **Engine adapters:** map portable tool semantics to Remotion, Three.js, Blender, Manim, FFmpeg, or future engines.

### Tool call lifecycle

```text
Creative goal
  -> Agent discovers relevant tools
  -> Reads tool schemas and examples
  -> Plans and invokes composable tools
  -> Receives structured results / diagnostics / artifacts
  -> Previews and inspects output
  -> Patches selected objects or shots
  -> Re-renders affected output
```

### Tool design rules

- Prefer narrow composable tools with clear inputs and outputs over a monolithic generate-video call.
- Offer both high-level creative helpers and low-level controls; the former must be buildable on the latter.
- Tool IDs and versions are stable; breaking changes require a new version.
- Tool manifests declare determinism, statefulness, cost, permissions, timeouts, engine dependencies, and produced artifacts.
- Discovery is dynamic. The agent must not need hard-coded knowledge of every available tool.
- Tool execution is logged with project/run/call IDs and structured diagnostics.
- Expensive or destructive operations require explicit permission policy and budget checks.
- Advanced code/shader execution runs in a restricted sandbox with resource and filesystem/network boundaries.
- Tool outputs return artifact references and content hashes, not unbounded inline binary payloads.

### Project model

The long-term canonical project contains:
- Editorial layer: research, claims, sources, narration, captions, creative brief.
- Sequence/timeline layer: sequences, shots, tracks, transitions, time ranges.
- Scene graph layer: nodes, parent-child relationships, transforms, geometry, materials, lights, cameras, animation tracks, constraints, simulation parameters.
- Asset layer: imported/generated/procedural assets, provenance, licenses, versions, hashes.
- Tool execution layer: manifests, tool calls, dependencies, outputs, diagnostics, artifacts.
- Render layer: engine, capability requirements, render settings, output profiles, quality reports.
- Revision layer: stable IDs, patches, snapshots, approvals, and rollback metadata.

### Creative freedom and engine portability

The agent may create novel scenes by composing primitives and tools. It is not restricted to a list of pre-authored scene templates. Templates and high-level tools are convenience layers.

Portable scene intent remains engine-neutral. Engine-specific features may be exposed as namespaced extensions (for example `three.camera.dof` or `blender.geometry.nodes`) with declared engine capabilities. The agent can choose the appropriate specialist engine per shot, while the project keeps a stable semantic structure.

### Iterative quality loop

Preview and inspection are part of the creative toolset:
- Render thumbnails, keyframes, shot proxies, or full drafts.
- Inspect images and metadata; report clipping, overlap, missing assets, unreadable text, frame discontinuities, audio clipping, and timing mismatch.
- Compare a revision against a prior render.
- Patch only affected scene nodes/shots and re-render dependencies.
- Preserve render manifests and tool traces for reproducibility.


## Initial tool runtime implementation

The first runtime slice lives in `src/platform/tool-registry.ts`:
- In-memory registration, removal, search, category filtering, and version lookup.
- Invocation through a gateway rather than direct agent access to implementations.
- AJV validation of tool inputs and outputs against manifest schemas.
- Optional permission allow-list checks.
- Per-tool timeout and structured started/completed/failed events.
- Structured diagnostics returned to the agent.

This is an initial local runtime, not yet the production execution service. Cancellation propagation, persistent traces, artifact storage, quotas, sandbox isolation, remote workers, and third-party plugin loading remain future work.
