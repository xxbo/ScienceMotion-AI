# ScienceMotion AI — Platform Vision

Last updated: 2026-11-13

## Product definition

ScienceMotion AI is an **extensible creative toolkit and execution framework for AI agents that create professional videos**.

It is not primarily a topic-to-template video generator. The platform exposes a broad, composable set of professional creative capabilities through discoverable, typed tools. An AI agent can plan a production, build scenes, manipulate assets, animate objects, simulate systems, compose shots, render previews, inspect results, and iteratively refine the work.

The platform should enable both:
- **Guided production:** use a script, storyboard, style guide, or reusable templates as helpful starting points.
- **Open-ended creation:** let the agent freely combine low-level tools and advanced engines to create original visual sequences that are not limited to predefined templates.

Templates are accelerators, never the ceiling.

## Product experience

The user describes an outcome or supplies source material. The agent then:
1. Understands the creative goal, audience, format, visual language, and constraints.
2. Plans the work and discovers the tools/capabilities needed.
3. Builds a scene graph and timeline using typed tool calls.
4. Uses specialist engines and assets where appropriate.
5. Renders previews, inspects frames and diagnostics, and iterates on individual shots.
6. Performs quality checks for visual defects, timing, audio, readability, and factual integrity.
7. Renders final deliverables and a reproducibility manifest.

The agent should be able to make creative decisions. The platform supplies reliable primitives, specialist capabilities, and feedback—not a rigid sequence of mandatory templates.

## Capability/tool domains

The tool catalog is expected to grow across these domains:

### 1. Project and composition
- Create/open projects, sequences, scenes, shots, layers, tracks, and nested compositions.
- Set canvas dimensions, frame rate, duration, color space, safe areas, and output profiles.
- Manage scene graph hierarchy, transforms, constraints, grouping, parenting, and reusable components.

### 2. 2D graphics and motion design
- Create text, vector shapes, paths, masks, gradients, strokes, icons, diagrams, grids, and callouts.
- Animate position, scale, rotation, opacity, path drawing, morphing, easing, keyframes, and constraints.
- Create kinetic typography, lower thirds, transitions, and infographic layouts.

### 3. 3D graphics and cinematography
- Create/import meshes, procedural geometry, materials, textures, lights, cameras, environments, and rigs.
- Control camera position, focal length, depth of field, motion paths, framing, and cuts.
- Support physically based materials, shadows, reflections, volumetrics, and post-processing where the engine allows.

### 4. Simulation and scientific visualization
- Particle systems, rigid-body motion, springs, fields, waves, fluids, trajectories, and procedural systems.
- Charts, plots, coordinate systems, equations, vectors, graphs, timelines, and data-driven diagrams.
- Explicit units, coordinate systems, simulation assumptions, seeds, and parameter ranges.

### 5. Assets and media
- Search/import images, video, audio, fonts, 3D models, textures, and reference material.
- Generate or transform assets through pluggable providers.
- Track provenance, rights, attribution, content hashes, and asset versions.

### 6. Audio and narration
- TTS provider discovery and voice selection.
- Generate/trim/align narration, captions, music, ambience, and sound effects.
- Mix levels, fades, ducking, spatial audio, and timeline synchronization.

### 7. Editing and compositing
- Timeline editing, retiming, transitions, masks, keying, blend modes, color correction, grading, and effects.
- Multi-layer compositing and shot-level overrides.
- Support non-destructive edits and reusable presets.

### 8. Rendering and feedback
- Preview a scene, shot, frame range, or full sequence.
- Render stills, proxies, drafts, and final-quality outputs.
- Inspect frames, compare versions, retrieve render logs, measure quality, and diagnose failures.
- Re-render only affected shots or assets when dependencies permit.

### 9. Code and specialist engines
- Invoke specialist renderers such as Remotion, Three.js, Manim, Blender, or future engines through adapters.
- Allow advanced custom scripts, shaders, procedural geometry, and simulation code in a restricted, reproducible sandbox.
- Expose engine-specific advanced tools without leaking those implementation details into the episode content contract.

## Agent tool system

The platform must provide a discoverable, extensible tool registry.

Every tool should declare:
- Stable tool ID and semantic version.
- Human-readable name, description, examples, and category.
- Typed input and output schemas.
- Required engine/capability and compatibility constraints.
- Whether it is deterministic, stateful, expensive, or destructive.
- Preview/inspection support and expected artifacts.
- Permissions and execution limits.

The agent workflow is:
- Discover/search tools by task and capability.
- Read exact schemas and examples before calling.
- Invoke tools through a stable tool gateway.
- Receive structured results, diagnostics, and artifact references.
- Inspect outputs and continue iterating.

Tool interfaces should describe **creative intent**, not force one specific renderer's API. Renderer adapters translate portable operations to the engines they support. Engine-specific extensions are allowed, but must be explicitly namespaced and capability-gated.

## Core data model and decoupling

Content and rendering remain strictly separated, but the platform needs a richer model than a script and fixed shot list.

The canonical project should contain:
- Editorial data: topic, research, sources, claims, narration, captions, and creative brief.
- Creative plan: storyboard, shots, sequence timing, visual direction, and references.
- Scene graph: typed nodes, relationships, transforms, materials, animation tracks, and simulation settings.
- Asset graph: files, generated assets, source provenance, licenses, and hashes.
- Tool execution graph: tool calls, inputs, outputs, dependencies, diagnostics, and artifact references.
- Render configuration: renderer selection, capability requirements, quality settings, and output profiles.
- Revision history: stable IDs, versioned changes, and approval state.

The model/agent can orchestrate and edit the project. Renderers consume the approved renderable project snapshot. Rendering must not rewrite editorial content or silently alter scene meaning.

## Design principles

1. **Agent freedom with professional controls:** expose both high-level creative tools and low-level building blocks.
2. **Composability:** small tools should combine into complex scenes and sequences.
3. **Progressive disclosure:** agents discover only relevant tools, but can inspect the full catalog.
4. **Renderer independence:** portable project data and tool semantics outlive any single engine.
5. **Specialist engines, one orchestration layer:** choose the right engine per shot or scene.
6. **Iterative visual feedback:** preview, inspect, diagnose, revise, and render again.
7. **Non-destructive and reproducible:** stable IDs, versioned assets, deterministic settings, execution logs.
8. **Quality over one-click claims:** render quality is measured and inspected, not assumed.
9. **Scientific and factual integrity:** sources, units, assumptions, and uncertainty travel with the project.
10. **Extensibility first:** third-party and future in-house tools can join the registry without rewriting the agent.

## MVP strategy

Do not attempt to implement every tool domain at once. Build the platform spine first:
1. Canonical project/scene graph and versioned schemas.
2. Tool manifest and registry contract.
3. Tool discovery, schema retrieval, and execution gateway.
4. Initial useful tools for project, 2D primitives, animation, timeline, asset references, preview, and inspection.
5. One renderer adapter with excellent iteration support.
6. Add 3D and specialist engines incrementally.
7. Prove that the same project can be rendered by more than one engine.

The CPU-cache episode remains the first end-to-end reference project and test fixture, not the product's only use case or architecture boundary.
