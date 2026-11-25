# P2 — Motion design and specialist rendering

Last updated 2026-11-25

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
| C — Editable motion | Next | Scoped edits change the intended path or timing, preserve other nodes and yield actionable diagnostics for invalid input |
| D — Delivery and restore | Planned | A tool-authored sample uses path following, with verified before, edited and restored media |

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
