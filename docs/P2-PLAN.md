# P2 — Motion design and specialist rendering

Last updated 2026-11-27

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
| C — Camera keys | Implemented | Position and rotation change the viewpoint in three decoded previews and all 42 frames of a trimmed export |
| D — Host delivery and restore | Implemented | Original, edited and restored deliveries, with 126 checked video frames and pixel-exact restore after reopen |

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

Applications can opt in with `openCreativeHost({ directory, renderer: new ThreeJsProjectGraphRenderer() })`. Without this selection, the Host still uses Remotion. The adapter applies A's scene restrictions before launching the browser, with C's narrow extension for camera motion. The separate browser entry uses Three.js geometries, a perspective camera, Lambert materials and the authored lights. It uses the provisioned Remotion browser with software WebGL2 via ANGLE and SwiftShader, so the check does not require a hardware GPU. [Adapter](../src/renderers/three/three-project-graph-renderer.ts) · [Three.js drawing](../src/renderers/three/three-static-browser.tsx).

The adapter returns an opaque PNG for the requested frame. For a static MP4 it paints once, then FFmpeg with `libx264` holds the raster for the requested number of frames at the snapshot FPS. The native browser surface admits dimensions up to 7680, subject to the actual WebGL2 limits. H.264 yuv420p additionally requires even dimensions and up to 900 frames. Media retains the exact snapshot and adapter identity through ordinary Host jobs. No layout inspection or new default renderer is added.

```sh
npx remotion browser ensure
npm run accept:p2-2-b
```

The acceptance uses the unchanged `three-static-v1` hash and renders preview frame 24 plus the silent two-second range `[0, 48)` at 640 × 360 and 24 fps. It decodes every frame, verifies both silhouettes against independently projected bounds, and checks the opaque background and brighter lit side of the sphere. The current regression submits a snapshot with enabled mesh keys and requires a scoped rejection before publication, with the artifact inventory unchanged. CI publishes `three-static-shot-evidence` containing both media files, the snapshot, receipts and pixel measurements. [Static shot acceptance](../scripts/three-static-shot-acceptance.ts).

### C — Camera keys

The opt-in Three.js adapter version 1.1.0 accepts one enabled track per `transform.position` or `transform.rotation` on the selected camera. Author the tracks through `animation.keyframes.set` and save a new Project Graph snapshot with `project.snapshot.save`. Position uses world XYZ units. Rotation interpolates the authored XYZ Euler degrees component-wise with no angle wrapping and then converts them to radians. Each unkeyed channel keeps its base pose. Sampling follows the existing step, linear, Bézier easing, endpoint hold and loop rules. Keys are zero-based within the scene, including a possible terminal boundary key at its duration. [Camera preflight](../src/renderers/three/three-static-scene.ts) · [Sampling tests](../src/platform/three-camera-keys.test.ts).

The preview samples the requested scene frame. The video samples `startFrame + outputFrame` and encodes the captured images in output order at the native FPS. With no enabled camera tracks the adapter still paints once and holds the static frame. Lens, scale, mesh and light animations remain unsupported. Invalid or unsupported tracks are rejected before browser work and publication, with track, node and scene identifiers and a request field path. No schema or default engine changes are needed.

```sh
npx remotion browser ensure
npm run accept:p2-2-c
```

Acceptance keeps the pinned static snapshot unchanged and authors a new one containing a camera slide followed by a pan. It decodes previews at scene frames 6, 23 and 47 and all 42 frames of the silent H.264 range `[6, 48)` at 640 × 360 and 24 fps. It checks both silhouettes against independent perspective projections and verifies the preview and video agree at matching frames. A camera scale track fails before publication without adding artifacts. CI publishes `three-camera-motion-evidence` with the four media files, snapshot, job receipts and measured poses. D covers reopen and restore. [Camera motion acceptance](../scripts/three-camera-motion-acceptance.ts) · [CI workflow](../.github/workflows/video-engine.yml).

### D — Host delivery and restore

The same opt-in Three.js renderer now has an end-to-end check through the existing Creative Host delivery API. Start with the pinned static scene and save C's camera move as an approved snapshot. Use `animation.keyframes.edit` to change only the final yaw from 14° to 6° and retain an edited snapshot. Deliver both while the edited revision is live, so the first delivery must read the approved snapshot rather than the working project. Each verifies its retained job receipts, PNGs at scene frames 6, 26 and 47 and all 42 H.264 frames of `[6, 48)` at 640 × 360 and 24 fps. The first preview is unchanged by the edit, while the final angle visibly changes. [Acceptance](../scripts/three-host-delivery-acceptance.ts).

Close and reopen the same workspace to verify the original and edited snapshots, jobs and artifact references. Restore the approved camera move over the edited revision and save a new snapshot with an explicit source hash and revision parent. The recovery check creates new jobs and requires decoded PNG and video pixels to match the original exactly. A final reopen confirms all 12 job receipts are retained. A mismatched approval and a restore candidate without the right lineage both fail without admitting render jobs or adding artifacts. The renderer and default engine are unchanged.

```sh
npx remotion browser ensure
npm run accept:p2-2-d
```

CI publishes `three-host-delivery-evidence` with three MP4s, nine PNGs, three snapshots, job receipts, restore provenance and all 126 pose measurements. This closes P2.2 engineering acceptance. P2.3-A defines the physical model for the first simulation. Human viewing stays in the final acceptance workstream. [CI workflow](../.github/workflows/video-engine.yml) · [Final human acceptance](PLAN.md#final-human-acceptance-workstream).

## P2.3 — Simulation and Manim

| Step | Status | Completion evidence |
| --- | --- | --- |
| A — Physical model | Implemented | Strict SI input, a nonlinear ideal pendulum, and ten verified analytic checkpoints for two rod lengths |
| B — Retained trajectory | Implemented | Two retained numerical trajectories, verified periods, ten checkpoints, energy bounds and byte-identical replay after reopen |
| C — Shared 2D and 3D samples | Implemented | Remotion and Three.js replay the same retained trajectory, with six checked previews and 89 frame pairs mapped to physical time |
| D — Mathematics shot | Implemented | Manim shows the model, measured cycle and angle trace, with 89 checked chart frames from the same replay clock |
| E — Time alignment | Implemented | Independently decode the three deliveries, match five visible events and one full cycle, and reject a three-frame timing slip |

### A — Physical model

Use an ideal simple pendulum with a point mass, a massless rigid rod of fixed length `L`, and a fixed pivot at the origin. Gravity has uniform magnitude `g` along −Y. The bob moves in the XY plane without damping, a drive or collisions. Mass cancels from the equation. Time `t` is measured in seconds from release, length and position in metres, angle in radians and angular velocity in rad/s. At `θ = 0` the bob is directly below the pivot. Positive `θ` moves the bob toward +X from that position. The first model accepts release from rest with `−π < θ₀ < π`. A release at zero stays at equilibrium and has no observed oscillation period. [Model schema](../schemas/pendulum-model.schema.json) · [Model code](../src/platform/pendulum-model.ts).

```text
dθ/dt = ω
dω/dt = −(g/L) sin(θ)
bob position = (L sin(θ), −L cos(θ), 0)
specific mechanical energy = ½(Lω)² + gL(1 − cos(θ))
```

The energy is per kilogram, with zero potential at the bottom. The nonlinear `sin(θ)` matters. At a nonzero release amplitude `A = |θ₀|`, the period is `T = 4 sqrt(L/g) K(sin(A/2))`, where `K(k)` is the complete elliptic integral of the first kind with modulus `k`. The small-angle expression `2π sqrt(L/g)` is an approximation. The pinned cases use standard gravity `g = 9.80665 m/s²` and release from −30°. Their periods for 0.5 m and 2 m are approximately 1.443444 s and 2.886889 s, about 1.74% above the small-angle values. With gravity and amplitude held fixed, four times the length gives twice the period. [Elliptic integral definition](https://dlmf.nist.gov/19.2#ii) · [AGM relation](https://dlmf.nist.gov/19.8#i).

| Time | Angle from down | Angular velocity | Event |
| --- | --- | --- | --- |
| 0 | −A | 0 | Release at the left extreme |
| T/4 | 0 | +ωmax | Pass the bottom toward +X |
| T/2 | +A | 0 | Reach the opposite extreme |
| 3T/4 | 0 | −ωmax | Pass the bottom toward −X |
| T | −A | 0 | Return to the release state |

At the bottom, energy conservation gives `ωmax = sqrt((2g/L)(1 − cos(A)))`. The fixture pins the five times, states and bob positions for each length. Its period targets come from the complete integral's series. Acceptance checks them with the arithmetic-geometric mean and independently checks acceleration, coordinates, fixed length and conserved energy at each checkpoint. Version, units, coordinate convention and physical parameters are explicit. Unsupported inputs fail with a field path. No screen pixels, FPS or editorial holds enter the model. The illustrated P2.1 scene and default renderer are unchanged. [Pinned reference](../examples/pendulum-physics-reference.json) · [Acceptance](../scripts/pendulum-physics-acceptance.ts).

```sh
npm run accept:p2-3-a
```

CI publishes `pendulum-physics-contract-evidence` with the reference, model schema and executable verification. A does not integrate, retain a trajectory or render media. For B the fixture requires period error at most 1 ms, checkpoint errors at most 0.0001 rad and 0.0001 rad/s, and relative specific-energy drift at most 0.00001 for these nonzero-energy reference cases. Measure a full cycle from the solved motion and compare states at the reference times. The nominal indices alone are not period measurements.

### B — Retained trajectory

Solver `pendulum-rk4` version 1.0.0 uses classical fourth-order Runge–Kutta on A's nonlinear equations. It takes an SI model and an explicit step size and count. Each reference case runs for 960 steps of 1/240 s and retains 961 samples, including time zero and 4 s. Four seconds covers at least two rightward bottom crossings in both cases. The solver receives neither a reference period nor an editorial clock. The v1 solver bounds its step count to 10,000 and requires `0 < h sqrt(g/L) <= 0.1` to resolve the natural time scale. [Solver](../src/platform/pendulum-trajectory.ts) · [Trajectory schema](../schemas/pendulum-trajectory.schema.json).

Each time-stamped sample stores angle, angular velocity, bob position and specific mechanical energy. Same-direction zero crossings are measured from neighboring retained samples, and time differences between them give the observed period. The acceptance compares the ten analytic checkpoints at their exact reference times using cubic Hermite interpolation of angle and angular velocity. It independently recomputes energy and checks the rod length at every retained sample against the physical model. [Acceptance](../scripts/pendulum-trajectory-acceptance.ts).

A data-only Project Graph snapshot binds the two content-addressed JSON artifacts. The test removes the working project's references, reopens the workspace and confirms garbage collection retains the snapshot's data but removes an unreferenced control blob. It checks the original SHA-256 identities and verifies byte-identical re-solving for the same input, solver and runtime. No rendered scenes or media are produced. C will map video frames to physical seconds and use the same retained data in both renderers.

```sh
npm run accept:p2-3-b
```

CI publishes `pendulum-trajectory-evidence` with both JSON trajectories, the data snapshot and a report of periods, checkpoints, drift and retention.

### C — Shared 2D and 3D samples

The replay subset uses an immutable metric, Y-up ProjectDocument with one sequence, one full-length shot and one root `simulation` node. Its `simulation` component has `{ "model": "pendulum-trajectory-v1", "assetId": "..." }` and binds one retained JSON data asset by ID and SHA-256. It does not compose other nodes, authored trims, keyframes, constraints, timeline effects or media. An export range inside the shot is supported. [Binding and clock](../src/platform/pendulum-replay.ts).

Select `RemotionPendulumReplayRenderer` or `ThreeJsPendulumReplayRenderer` when opening Creative Host. The Host reads the declared local artifact, then both adapters use the same preflight and Hermite sampler before their browsers start. For output index `i`, the source frame is `startFrame + i`, and physical time in seconds is `sourceFrame / fps`. A preview uses the same rule for one frame. The browser compositions receive verified poses in output order. Neither runs the solver nor resets the physical clock when an export starts mid-shot. Missing or altered data and ranges extending past the trajectory are rejected. The existing default renderer, worker and Three.js project-graph identities are unchanged. Layout inspection is not part of this replay subset.

Both views fit the same world-space positions to a unit rod and the same front projection. Remotion paints the guide, pivot, rod and bob as SVG, and Three.js renders lit solid geometry with an orthographic camera. Acceptance reuses B's exact retained 2 m trajectory bytes and the same replay snapshot in two separately opened Hosts. It renders a 640 × 360, 25 fps silent clip for source frames `[7, 96)` and previews frames 7, 51 and 95. The 25 fps clock exercises interpolation between B's 240 Hz samples. It measures the decoded pivot, rod and bob, checks all 89 frame pairs against the retained positions within 2 px and verifies both engines' job receipts. [Acceptance](../scripts/pendulum-replay-acceptance.ts).

```sh
npm run accept:p2-3-c
```

CI publishes `pendulum-replay-evidence` with the two videos, six previews, the source trajectory, replay snapshot, receipts and per-frame comparison.

### D — Mathematics shot

Manim Cairo renders a standalone Mandarin mathematics shot with the nonlinear equation `θ̈ + (g/L) sin θ = 0`, the 2 m model parameters, and a plot of `θ(t)`. The curve connects B's exact 240 Hz retained samples. Two rightward bottom crossings give the measured period of about 2.887 s. The comparison of about 2.837 s is the small-angle expression `2π sqrt(L/g)`, not a second measurement. The chart marks the first five phases at continuous physical times inferred from the sampled angle or angular velocity, with no snapping to video frames. [Shot preparation](../src/platform/pendulum-math-shot.ts) · [Manim scene](../src/renderers/manim/pendulum_math_scene.py).

The Manim input binds the same trajectory hash and replay snapshot as C. The shared replay sampler supplies one time and angle per exported frame, so the first chart cursor and readout use `7 / 25 = 0.28 s`. Manim draws those poses in output order and neither integrates the model nor restarts physical time. Acceptance checks the five phase times against A (within 1 ms), verifies the formula and plot are visible, independently locates the orange chart marker on each of the 89 decoded frames (within 2 px of the retained angle and time), and retains three previews. [Acceptance](../scripts/pendulum-math-acceptance.ts).

The standalone path requires Manim 0.19.1, Cairo/Pango, DejaVu Sans and Sans Mono, Noto Sans CJK SC, and FFmpeg/ffprobe. For example, on Ubuntu 24.04 after `npm install`:

```sh
sudo apt-get install --no-install-recommends build-essential pkg-config libcairo2-dev libpango1.0-dev \
  python3-venv fonts-dejavu-core fonts-dejavu-mono fonts-noto-cjk ffmpeg
python3 -m venv .venv-manim
.venv-manim/bin/python -m pip install -r requirements-manim.txt
PENDULUM_MANIM_PYTHON=.venv-manim/bin/python npm run accept:p2-3-d
```

CI publishes `pendulum-math-evidence` with the MP4, the three PNGs, source and snapshot JSON, Manim input, and per-frame verification. Host integration and multi-engine editing of the Manim segment belong to P2.4.

### E — Time alignment

Verify the exact C and D deliveries from one checkout. The acceptance binds their immutable replay snapshot, revision, and B trajectory SHA-256, checks the two Creative Host receipts and Manim manifest against the three distinct MP4s, and decodes all 89 frames of each clip again. The MP4 presentation clock starts at zero, but the corresponding physical times span 0.28–3.80 s. The release at zero is outside the export and is not counted. [Input bindings](../scripts/fixtures/pendulum-alignment-inputs.ts).

The two motion views recover a signed angle from the orange bob relative to the fixed pivot. The mathematics view recovers an angle from the orange chart marker's vertical coordinate and checks its horizontal time coordinate. The detector uses those decoded observations, not the renderers' per-frame reports or the expected event times. Consecutive sign changes give directed bottom crossings by linear interpolation. An 11-frame quadratic fit around each interior maximum or minimum reduces pixel quantization at the two turns. The reference comes separately from zero crossings of angle and angular velocity in the 240 Hz retained trajectory and agrees with A's analytic times within 1 ms. [Event detector](../src/platform/pendulum-event-alignment.ts).

The three views must show the same five events in order, including three bottom crossings and two turns. Each event must be within one 25 fps frame (40 ms) of the reference, and the spread across views must also be at most 40 ms. The period between the two rightward crossings must meet the same limits. As a negative control, advancing just the decoded Manim angle trace by three frames must preserve the event order but fail the timing comparison. Sub-frame estimates describe the comparison, not a higher video capture rate. [Acceptance](../scripts/pendulum-alignment-acceptance.ts).

```sh
PENDULUM_MANIM_PYTHON=.venv-manim/bin/python npm run accept:p2-3-e
npm run verify:p2-3-e  # Re-check C and D outputs from this checkout without re-rendering.
```

CI downloads the actual `pendulum-replay-evidence` and `pendulum-math-evidence` from the same run and publishes `pendulum-alignment-evidence` with the three original videos, snapshot, trajectory, decoded observations and comparison report. This closes P2.3 engineering acceptance. P2.4-A defines retained shot segments for subsequent editing. No combined cut or deferred human presentation review is delivered here. [CI workflow](../.github/workflows/video-engine.yml).

## P2.4 — Multi-engine editing

| Step | Status | Completion evidence |
| --- | --- | --- |
| A — Retained shot segments | Implemented | Versioned descriptors for two verified MP4s, with independent retention and byte-exact recovery after reopen |
| B — Two-engine cut | Implemented | Append the two retained MP4s without re-encoding, then check the frame map, all 178 decoded frames and the cut point |
| C — Trim and reorder | Next | Apply explicit segment-local trims and order changes while preserving inputs |
| D — Manim and recovery | Planned | Admit the standalone Manim segment and verify rejection and reopen for the assembled cut |

### A — Retained shot segments

A segment describes one finished delivery, not a placement on an editing timeline. `RetainedShotSegment` v1 binds a project ID, source snapshot ID/revision/document hash, source coordinate scope, half-open frame range, native profile, renderer ID/version, render job ID/input hash and the verified MP4 identity. The scope is the explicitly requested scene or the snapshot's primary sequence. Source frame `startFrame + i` corresponds to MP4 frame `i`, even at a nonzero start. The v1 intake takes a trusted, succeeded Host video receipt. It verifies silent H.264 `yuv420p` at the admitted integer frame rate and native even dimensions. It decodes all advertised frames and verifies their presentation timestamps in integer ticks, so a valid average frame rate alone cannot pass. No resize, retime or transcode is performed. [Contract](../src/contracts/retained-shot-segment.ts) · [Schema](../schemas/retained-shot-segment.schema.json).

`RetainedShotSegmentStore` publishes a canonical JSON descriptor as a content-addressed data artifact. The segment owns three references, one to its descriptor, one to the source snapshot envelope, and one to the original video. A repeat capture of the same receipt and content is idempotent. The decoded RGB hash is reported as evidence, not used as the segment ID. Using the shared local lifecycle manager, the store verifies the whole pin set and attaches the descriptor last. A reader needs all three references and checks hashes rather than reopening the original render job or re-rendering. Different segments may share their source snapshot artifact. The envelope is provenance, not a backup of every asset needed to render the source project. A installs no public Host tools and does not modify the default renderer or place anything on a timeline. [Store](../src/platform/retained-shot-segment.ts).

Acceptance consumes C's actual Remotion and Three.js Host deliveries from one checkout. Each MP4 contains 89 frames at 640 × 360 and 25 fps from source range `[7, 96)`. It checks idempotent capture, rejects a mismatched snapshot and receipt, rejects selectively altered presentation timing, releases the original snapshot and video-owner references, and reopens after collecting unreferenced controls. The two recovered MP4s must match the originals byte for byte, and a changed video read must fail its hash check. [Acceptance](../scripts/retained-shot-segment-acceptance.ts).

```sh
npm run accept:p2-4-a
npm run verify:p2-4-a  # Use C's retained outputs from the same checkout without rendering again.
```

CI publishes `retained-shot-segment-evidence` with both descriptors and original MP4s, their source snapshot, the v1 schema, and the recovery report.

### B — Two-engine cut

`assembleShotCut` accepts two ordered full segment IDs and reads both through the verified A store. A versioned plan preserves each renderer and exact source binding, and assigns contiguous, half-open output ranges. Both segments must have the same native width, height and integer FPS. There is no renderer invocation, resize, retime, trim, transition or persistent edit in this slice. [Plan contract](../src/contracts/shot-cut.ts) · [Assembly](../src/platform/shot-cut.ts).

The two real input engines emit different MP4 track timescales even at 25 fps. FFmpeg remuxes each to a common integer clock and copies the compressed video into one silent H.264 MP4. The `avc3` sample entry permits the clips' H.264 parameter sets in-band. The assembler checks the output profile, start, full presentation clock and per-frame decoded RGB hashes in the declared order. It rejects any incompatible media or changed, lost, duplicated or misordered decoded frame, with no transcode fallback.

Acceptance recovers both A IDs from their receipts and exact archived bytes. The cut has 178 frames at 640 × 360, 25 fps and lasts 7.12 s. Remotion covers output `[0, 89)` and Three.js covers `[89, 178)`. At the cut, output frame 88 maps to Remotion source frame 95, and output frame 89 maps to Three.js source frame 7. Both previews are extracted from the cut and verified against the matching decoded frame. A duplicated seam frame fails, even with the original frame count. [Acceptance](../scripts/two-engine-cut-acceptance.ts).

```sh
npm run accept:p2-4-b
npm run verify:p2-4-b  # Assemble from A's retained outputs for the same checkout.
```

CI publishes `two-engine-cut-evidence` with the cut, plan and frame hashes, two seam PNGs and the acceptance report. C will add explicit segment-local trims and reorder an edit without changing its retained inputs. D will add Manim and test assembled-cut recovery.
