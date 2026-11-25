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
| B — Path following | Next | A reusable path-following operation follows the reference arc and meets the same position and timing checks |
| C — Editable motion | Planned | Scoped edits change the intended path or timing, preserve other nodes and yield actionable diagnostics for invalid input |
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

CI uploads `pendulum-reference-evidence` from `out/pendulum-reference/`. It contains the fixture, inspection and per-check evidence, snapshot-bound receipts, three PNGs and the reference MP4. P2.1-B can use the same frame and geometric checks when it substitutes the reusable path-following motion. [Acceptance script](../scripts/pendulum-reference-acceptance.ts) · [CI workflow](../.github/workflows/video-engine.yml).
