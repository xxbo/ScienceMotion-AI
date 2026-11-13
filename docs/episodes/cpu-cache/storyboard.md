# CPU Cache — Storyboard

Master format: 1920×1080, 30 FPS, 60 seconds.

| Time | Scene | Visual explanation | Narration |
|---|---|---|---|
| 00:00–00:08 | The problem | CPU and DRAM separated by a data path; animated request packet | CPU needs data; waiting can waste compute time |
| 00:08–00:16 | The bottleneck | Execution activity with visible wait gaps | Data supply can become the bottleneck |
| 00:16–00:26 | Cache hierarchy | L1/L2/L3/DRAM layered stack | Multiple cache levels trade capacity for proximity and latency |
| 00:26–00:36 | Cache hit | Request finds data in cache and returns | A hit takes the shorter cache path |
| 00:36–00:46 | Cache miss | Lookup proceeds through levels toward DRAM | A miss requires searching a lower level, potentially main memory |
| 00:46–00:54 | Locality | Sequential array cells and repeated access highlight | Temporal and spatial locality make caching effective |
| 00:54–01:00 | Takeaway | Three concise principles | Cache keeps useful data closer to compute |

## Production notes

- All diagrams are conceptual, not a cycle-accurate depiction of a particular CPU.
- Do not display universal cache latency numbers.
- Keep the distinction between capacity, latency, and bandwidth.
- Caption copy should remain readable on mobile; the current first pass uses a single scene-level caption.
