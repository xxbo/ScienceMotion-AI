# P2 — Motion design and specialist rendering

Last updated 2026-11-26

Build on the canonical Project Graph, retained snapshots, Creative Host and verified media delivery. Keep each increment independently testable and leave the default renderer in place. A Host currently selects one renderer at launch and the timeline's visual clips are still PNGs. Single-shot rendering and multi-engine editing therefore have separate milestones. [Engine boundary](P1.5-PLAN.md#engine-boundary) · [Timeline editing](P1.3-PLAN.md#b--timeline-editing).

| Milestone | Planned increments |
| --- | --- |
| P2.1 — Advanced 2D motion | A pin the reference, B path following, C editable motion and diagnostics, D delivery and restore |
| P2.2 — Three.js and camera motion | A define the first 3D subset, B render a static shot, C add camera keys, D verify Host delivery and restore |
| P2.3 — Simulation and Manim | A define the physical model, B solve and retain a trajectory, C share samples across 2D/3D, D make the mathematics shot, E verify time alignment |
| P2.4 — Multi-engine editing | A define retained shot segments, B assemble a two-engine cut, C trim and reorder, D add the Manim segment and test rejection and reopen |
| P2.5 — Offline Blender | A verify the bounded headless runtime, B render a shared 3D shot, C verify optional replacement and recovery |
| P2.6 — Audio and final delivery | A add a background audio track, B mix and duck, C check decoded audio timing, D assemble and revise the short, E verify failure and recovery |

The work starts with P2.1 and P2.2. P2.3 and the initial two-engine cut of P2.4 can advance independently after that. Blender can be tested independently and uses the P2.4 segment handoff for optional replacement. The final P2 engineering acceptance preserves representative media. Human presentation review stays in the separate final acceptance workstream. [Acceptance boundary](PLAN.md#final-human-acceptance-workstream).

## P2.1 — Advanced 2D motion

| Step | Status | Completion evidence |
| --- | --- | --- |
| A — Reference | Implemented | A frozen pendulum snapshot, exact checkpoint and direction expectations, and verified real PNG and MP4 outputs produced with the existing Remotion renderer |
| B — Path following | Implemented | A reusable 2D guide binding follows straight segments and circular arcs by length. The separate path-driven bob matches A's scene timing and decoded frame checks |
| C — Editable motion | Implemented | Tools bind and edit a single motion path by revision. Decoded previews isolate the changes, and rejected edits keep the same revision and hash |
| D — Delivery and restore | Implemented | A pendulum built from an empty workspace through public tools, with three verified deliveries and pixel-exact restore after reopen |

### A — Pendulum reference

The six-second shot titled **单摆的运动与周期** teaches first-time viewers how to recognize one complete swing. The bob goes from a release extreme through the lowest point to the opposite extreme, then returns to its original extreme. The opposite side is only halfway through a cycle. The geometry and timing in this repository are authored for the illustration. The shot uses no physical length or gravity value, and its cycle time is not a measured or solved period. The physical model and length-to-period gate belong to P2.3. [OpenStax, Pendulums](https://openstax.org/books/university-physics-volume-1/pages/15-4-pendulums).

The fixture pins `pendulum-motion-v1` at 640 × 360, 20 fps and frames `[0, 120)`. It uses screen coordinates with Y increasing down, a pivot at `(222, 128)`, a 144 px radius and illustrated extremes at ±18°. The rigid rod and bob are children of a group with an authored rotation track. Existing easing shapes the quarter swings. The bookend holds are editorial. No new path-following or physics logic is used in A. [Fixture](../examples/pendulum-motion-reference.json) · [Deterministic fixture recipe](../scripts/fixtures/pendulum-reference.ts).

| Frame(s), zero-based | Expected result |
| --- | --- |
| 0–11 | Opening hold at the left extreme |
| 12, 60, 108 | Left extreme at `(177.502, 264.952)`, with returns after 48 and 96 motion frames |
| 24, 72 | Lowest point at `(222, 272)`, crossing toward the right |
| 36, 84 | Right extreme at `(266.498, 264.952)` |
| 48, 96 | Lowest point at `(222, 272)`, crossing toward the left |
| 108–119 | Closing hold at the left extreme |

The acceptance validates the canonical fixture and saves the exact revision in a private workspace. It runs model inspection across all 120 frames and invokes the default Host renderer on that snapshot. PNG previews at 12, 24 and 36 check the fixed pivot color and the decoded bob's center within 1 px. The silent H.264 MP4 must decode to 120 frames at the approved profile. A color mask identifies the bob in every decoded frame. Its measured radius and checkpoint centers must be within 2 px, both holds must remain at the left endpoint, and the frames two before and after each crossing must be on the expected sides. The RGB tolerance is zero for interior PNG bob pixels and ten channel levels for video. Receipt and decoded hashes are recorded separately.

With project dependencies, the Remotion browser, a CJK font and system FFmpeg and ffprobe installed, run

```sh
npm run accept:p2-1-a
```

CI uploads `pendulum-reference-evidence` from `out/pendulum-reference/`. It contains the fixture, inspection and per-check evidence, snapshot-bound receipts, three PNGs and the reference MP4. B reuses the same frame and geometric checks. [Acceptance script](../scripts/pendulum-reference-acceptance.ts) · [CI workflow](../.github/workflows/video-engine.yml).

### B — Path following

Use an enabled, renderer-neutral `follow-path` constraint with a `progress` block. The source is the follower and the target is its SVG path node. The existing `parameters.pathNodeId` matches the target ID. Both nodes share a parent in the same scene. Progress keys are numbers from 0 to 1 and use scene-local frames and the existing keyframe easing, steps and optional looping. Decreasing progress moves backward and repeated values hold. Easing overshoot is limited to the path endpoints. A legacy reservation without a progress block does not move anything. [Binding](../src/platform/follow-path.ts) · [Project parameters](../src/contracts/project.ts).

```json
{
  "id": "move-marker",
  "type": "follow-path",
  "sourceNodeId": "marker",
  "targetNodeId": "guide",
  "enabled": true,
  "parameters": {
    "pathNodeId": "guide",
    "anchor": [14, 14],
    "progress": { "keyframes": [{ "frame": 0, "value": 0 }, { "frame": 12, "value": 1 }, { "frame": 24, "value": 0 }] }
  }
}
```

The initial guide supports one open, continuous subpath of line commands (`M`, `L`, `H` and `V`) and circular `A` commands, including relative coordinates and implicit repetitions. It samples by distance along the guide in its own coordinate space, then projects through the guide's transform. An optional follower-local `anchor` places a point such as the center on the guide. Path following supplies the position while preserving the follower's own rotation, scale and opacity. It does not orient the object along the tangent. Other SVG commands still work for static art. A nonmatching path, disconnected guide or competing position driver is rejected for active motion. Existing engine support stays unchanged outside Remotion's 2D projection. The dedicated editing tools belong to C. [Sampler](../src/platform/motion-path.ts) · [Render projection](../src/renderers/remotion/project-render-model.ts).

```sh
npm run accept:p2-1-b
```

The acceptance leaves `pendulum-motion-v1` unchanged and derives a separate retained snapshot, `pendulum-path-motion-v1`. It splits the visible arc from the center guide and detaches the bob from the rotating arm. The arm keeps its original keys for the rod. The independent bob follows the arc with the same timing and easing. Disabling just its path binding leaves the bob at the lowest point in the model, confirming that path motion supplies its position. The two projected bob centers must agree to within 0.002 px across all 120 frames. The decoded PNGs and MP4 must pass A's unchanged position, radius, hold and crossing checks. CI publishes the two snapshot identities, comparison, receipts and media as `pendulum-path-following-evidence`. [Derived reference](../scripts/fixtures/pendulum-path-reference.ts) · [Motion tests](../src/platform/follow-path.test.ts).

### C — Editable motion

`animation.path.bind` attaches an existing follower to an existing sibling SVG path. Supply `baseRevisionId`, a new `constraintId`, `followerNodeId`, `guideNodeId` and `keyframes`. Optional `anchor` and `loop` use B's conventions. `animation.path.edit` addresses that active binding by `baseRevisionId` and `constraintId`. Its `changes` can replace `pathData` on the guide, the complete scene-local progress `keyframes`, or `loop`. Omitted fields stay unchanged, and the edit cannot reassign the nodes or the anchor. [Tool implementations](../src/platform/workspace-tools.ts).

For example, this changes both the path and the time it takes to reach the end in one revision.

```json
{
  "baseRevisionId": "current-revision-id",
  "constraintId": "motion-probe",
  "changes": {
    "pathData": "M0 0 L40 30 H96",
    "keyframes": [{ "frame": 0, "value": 0 }, { "frame": 24, "value": 1 }]
  }
}
```

Both tools require `project.read` and `project.write` and use the canonical `1.3.0` project patch transaction. The receipt names the new revision, affected constraint and any directly updated guide node. A timing-only edit reports no changed node IDs. An edit of shared guide geometry is rejected by the one-binding tool with the IDs of the other affected constraints. Editing just the timing remains possible on a shared guide. Invalid SVG or motion commands, conflicting bindings and invalid progress report error codes plus the binding, follower and guide IDs. Out-of-range progress and out-of-scene keys identify the offending frame. A stale request reports the submitted and current revisions. None of these rejections writes a partial revision. [Patch schema](../schemas/project-patch.schema.json) · [Editing tests](../src/platform/motion-edits.test.ts).

```sh
npm run accept:p2-1-c
```

The acceptance adds an independent amber probe to the spare area of B's pendulum canvas through public tools. It preserves the original pendulum and separates path and timing into two edits. The decoded frame-24 dot centers are `(90, 214)` before editing, `(85, 244)` with the reshaped path and `(138, 244)` after retiming. Every pixel outside the probe region must match. An unsupported guide, a combined path edit with invalid timing and a stale edit each preserve the exact prior revision and content hash. CI uploads the three snapshots, PNGs, receipts and recorded diagnostics as `pendulum-motion-edit-evidence`. The full tool-authored sample, export and restored output belong to D. [Acceptance script](../scripts/pendulum-motion-edit-acceptance.ts).

### D — Delivery and restore

The six-second **单摆的一个周期** sample starts from an empty project. Its scene, text, shapes, paths and rotation track are made through discovered Creative Host tools. `animation.path.bind` drives the bob and places its center on the circular guide. One `project.patch.apply` transaction uses `edit-follow-path` to change the guide and progress keys and `put-animation-track` to keep the rod aligned. The only authored changes are the guide path, the binding's timing and the rod's rotation keys. This is an illustration of one complete swing, not a measurement or solution of the pendulum equation. The two versions deliberately vary amplitude and authored time independently. A's pinned snapshot and B and C's checks remain unchanged. [Tool recipe](../scripts/fixtures/pendulum-delivery.ts).

| Zero-based animation checkpoints | Before and restored | Edited |
| --- | --- | --- |
| Release at the left extreme | Frame 12 at `(166, 247)` | Frame 12 at `(138, 231)` |
| Cross the lowest point to the right | Frame 30 at `(216, 257)` | Frame 34 at `(216, 257)` |
| Reach the opposite extreme | Frame 48 at `(266, 247)` | Frame 56 at `(294, 231)` |
| Cross to the left | Frame 66 at `(216, 257)` | Frame 78 at `(216, 257)` |
| Return to the starting extreme | Frame 84 | Frame 100 |

Each snapshot is delivered through the existing retained render-job verification. Remotion outputs PNGs at frames 0, 59 and 119 plus a silent 120-frame H.264 MP4 at 640 × 360 and 20 fps. Independent geometry checks verify the bob center, fixed pivot and aligned rod in all frames of all three videos, with a 2 px bob tolerance. Pixels outside the sweep region match in the before and edited PNGs. The host is closed and reopened, the two snapshots and their job receipts are re-read, then the original content is restored as a new revision that records the source snapshot hash. Fresh restore jobs must reproduce all three original decoded PNGs and all 120 original video frames exactly. [Delivery acceptance](../scripts/pendulum-delivery-acceptance.ts).

```sh
npm run accept:p2-1-d
```

CI publishes `pendulum-delivery-evidence` with the three MP4s, nine PNGs, snapshots, scoped tool calls, receipts and per-frame motion measurements. This closes P2.1's engineering scope. P2.2 starts by defining the first supported Three.js subset. Human viewing and presentation review remain separate. [CI workflow](../.github/workflows/video-engine.yml) · [Final human acceptance](PLAN.md#final-human-acceptance-workstream).

## P2.2 — Three.js and camera motion

| Step | Status | Completion evidence |
| --- | --- | --- |
| A — Static scene contract | Implemented | A pinned ProjectDocument, an executable preflight for the first supported 3D scene and scoped diagnostics for unsupported inputs |
| B — Static shot | Implemented | An opt-in Three.js adapter renders the pinned box and sphere, with decoded checks on a PNG and 48 MP4 frames |
| C — Camera keys | Next | Scene-local camera keyframes change the viewpoint predictably |
| D — Host delivery and restore | Planned | Snapshot-bound media and matching output after reopening and restoring |

### A — Static scene contract

The first subset consumes the existing ProjectDocument 1.1.0 through the common snapshot render request. It requires one sequence, scene and full-length shot, starting at frame zero without a source trim. The scene uses `right-handed-y-up` coordinates, sRGB colors and unconverted world units. Preview frames and video ranges must fit the shot and use its native profile, retained revision and exact content hash. [Project schema](../schemas/project.schema.json) · [Static preflight](../src/renderers/three/three-static-scene.ts).

| Root node | Required renderer-neutral components | Meaning |
| --- | --- | --- |
| `mesh` | `geometry` with `primitive: "box"` and `width`, `height`, `depth`, or `primitive: "sphere"` and `radius`. `material` with `model: "lambert"` and `color: "#RRGGBB"`. | Geometry is centered on the node origin. The material is opaque. |
| `camera` | Exactly one camera node with `projection: "perspective"`, `fovYDegrees`, `near` and `far` in its `camera` component. | Field of view is vertical and strictly between 0 and 180 degrees. Clip distances are positive, with `near < far`. Before rotation the camera looks along local −Z with +Y up. |
| `light` | `light` with `type: "ambient"` or `"directional"`, `color: "#RRGGBB"` and nonnegative `intensity`. A directional light also requires a three-number `target`. | Ambient light has no position. A directional light points from its world position to its distinct world target. |

Mesh and camera rotations use XYZ Euler order in degrees and are normalized to radians for the adapter. Mesh scales must be positive. Cameras and lights use unit scale. Light rotations must be zero. Pivots must be zero if specified. Positions, geometry extents and camera projection coefficients must remain representable at float32 precision. The normalized background is `#07111f`. All nodes are unique scene roots. Editorial names, metadata and provenance are not render instructions.

Unsupported content is rejected, including hierarchy or prefabs, external geometry or textures, engine-tagged or extra component data, enabled animation or constraints, media, timeline tracks, captions and transitions. Disabled animation and constraint entries remain inert. Failures provide a stable `THREE_STATIC_*` code, a JSON Pointer into the render request and any relevant scene, node, track or constraint ID. For example, an enabled camera track reports `THREE_STATIC_UNSUPPORTED_ANIMATION` at `/project/animationTracks/0` and names both the track and its camera. [Boundary tests](../src/platform/three-static-scene.test.ts).

```sh
npm run accept:p2-2-a
```

The pinned `three-static-v1` reference is a box, sphere, camera and two lights with a 48-frame shot at 640 × 360 and 24 fps. Acceptance verifies the standard schema, immutable snapshot, normalized preview and range requests and eight rejected cases. CI publishes `three-static-contract-evidence` with the snapshot, normalized scene and diagnostics. A does not load Three.js, register a renderer or produce media. Remotion stays the default, and B renders this reference without a second scene format. [Pinned scene](../examples/three-static-scene.json) · [Acceptance](../scripts/three-static-contract-acceptance.ts).

### B — Static shot

Applications can opt in with `openCreativeHost({ directory, renderer: new ThreeJsProjectGraphRenderer() })`. Without this selection, the Host still uses Remotion. The adapter validates the immutable request with A's preflight before launching the browser. The separate browser entry uses Three.js geometries, a perspective camera, Lambert materials and the authored lights. It uses the provisioned Remotion browser with software WebGL2 via ANGLE and SwiftShader, so the check does not require a hardware GPU. [Adapter](../src/renderers/three/three-project-graph-renderer.ts) · [Three.js drawing](../src/renderers/three/three-static-browser.tsx).

The adapter returns an opaque PNG for the requested frame. For a static MP4 it paints once, then FFmpeg with `libx264` holds the raster for the requested number of frames at the snapshot FPS. The native browser surface admits dimensions up to 7680, subject to the actual WebGL2 limits. H.264 yuv420p additionally requires even dimensions and up to 900 frames. Media retains the exact snapshot and adapter identity through ordinary Host jobs. This slice still rejects enabled camera keys and does not add layout inspection or a new default renderer.

```sh
npx remotion browser ensure
npm run accept:p2-2-b
```

The acceptance uses the unchanged `three-static-v1` hash and renders preview frame 24 plus the silent two-second range `[0, 48)` at 640 × 360 and 24 fps. It decodes every frame, verifies both silhouettes against independently projected bounds, and checks the opaque background and brighter lit side of the sphere. It also submits a snapshot with enabled camera keys and requires a scoped rejection before publication, with the artifact inventory unchanged. CI publishes `three-static-shot-evidence` containing both media files, the snapshot, receipts and pixel measurements. C adds camera motion. D verifies delivery and restore. [Static shot acceptance](../scripts/three-static-shot-acceptance.ts).
