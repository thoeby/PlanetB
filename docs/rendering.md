# Rendering: quality, time, and where ray tracing goes

**Status (0103).** `assemble-v3` bakes the one sky and the ground's own
shadow into every vertex and reads the elevation whole (257 across a tile);
`frame-v5` draws those colours unlit; `sample-v4` keeps them; the ground mesh
computes the same. One look, no seams. Iterations 2 000 / 2 500. Earlier: `train-v2` does T1–T5 (full-budget
seed, no growth, frozen positions, maintenance every 500, 2 000/1 500
iterations, z18 at 1024 px, overflow reported as `dropped`); `frame-v2`
path-traces with three.js + three-gpu-pathtracer (Q1, Q2 and the top-down
camera bug); the viewer cap is 12 M. Open: D-SSIM in the loss (Q4), band-1
colour (Q6), a lit `sample-v4` (Q7), and measuring any of it on a GPU.

What limits the picture and the compile time as the code stands on this
branch, and the plan to get (a) a better tile and (b) a compiled z18 tile in
about a minute on a decent GPU. Numbers are read off the code
(`client/lib/*`, `db/0017_verifydag.sql`); training speeds are estimates, since
no box that has run this had a hardware GPU (PROGRESS.md deviation 57).

## 1. The pipeline as built

| z | edge | splats | path | frames | iters |
|---|---|---|---|---|---|
| 18 | 110 m | 2 M | assemble → frame → train → sog → verify×3 | 120 @ 1024², trained @ 512² | 7 000 |
| 16 | 440 m | 600 k | same | 56 @ 1024², trained @ 512² | 5 000 |
| 14 | 1.7 km | 800 k | assemble → sample → sog | – | – |
| ≤12 | | 0.9–1.5 M | merge → sog | – | – |

The look is authored, not photographed (SPEC §7 removed ortho draping):
terrain is a height-band palette with slope rock and a DEM-only openness term
(`terrain.js`), objects are canonical GLBs, everything is lit by the one fixed
sky in `light.js`. So **quality is lighting × geometry × what the trainer
recovers**, and there is no imagery to hide behind.

## 2. What limits quality

Ordered by how much of the picture each one costs.

**Q1 No shadows, no occlusion between objects.** `render.js` shades by
normal only (`lightAt(n, 1.0)`, openness fixed at 1). A house does not shade
the ground, a tree does not shade a house, a valley wall does not shade the
valley. In an authored world this is most of the difference between "model
viewer" and "place". Baked into every trained tile via the frames, and into
every sampled tile via `shade()`.

**Q2 GLB textures are dropped.** `glbmesh.js` bakes the material's base
colour into vertices; the frame renderer has no samplers. An uploaded model
with 4096² textures (the SPEC's limit) renders as flat colour, so the trainer
can only ever learn flat colour. Also the reason detail budgets are wasted:
a splat cannot carry detail the frame never showed.

**Q3 The trainer silently drops splats in dense tiles.** `CAPACITY = 1024`
per 16×16 screen tile (`gsgpu.js`); over that, `scatter()` loses the atomic
race and the splat is neither rendered nor given a gradient. At 512² there
are 1 024 screen tiles: 600 k splats average 600 per tile (already over in
the middle of ring views), **2 M splats average 2 000 — a z18 tile is over
capacity almost everywhere.** Listed as an open item for z16; for z18 it is
the ceiling on PSNR before anything else is.

**Q4 Loss is L1 + 0.2 L2, no D-SSIM** (`gswgslgrad.js LOSS`). 3DGS's
structural term is what keeps edges sharp; without it the optimiser is happy
with a blurred fit. Cheap to add (an 11×11 separable window, one more pass).

**Q5 Trained at 512 px.** At z18 a ring view spans ~115 m, so 22 cm/px; a
street view of a façade is coarser than the 8 cm splat spacing the budget
pays for. Fine for z16. For z18 the last third of iterations should be at
1024 (frames are stored at 1024 already).

**Q6 Band-0 colour only** (`gsmodel.js`, `sogenc.js`). No view dependence,
so a splat is one colour from every side; the engine reads `shN` already.
Worth it only after Q1/Q2, and only at z18.

**Q7 Sampled tiles get occlusion from the DEM only.** `openAt()` looks at
DEM neighbours within three posts; buildings and trees cast nothing and
receive nothing.

## 3. What limits time

Per iteration on the GPU path (`gsgpu.js step`): preprocess, per-tile
bitonic sort, render, loss, backward (per-pixel walk with workgroup float
atomics), project, Adam — one submit, no readback. Reasonable design. What
is expensive around it:

**T1 Maintenance every 100 iterations round-trips the whole model.**
`train()` calls `backend.save()` (readback of 5 param + 2 moment buffers, 42
floats a splat), runs `maintain()` and `jitter()` on the CPU, then `load()`
re-allocates every buffer and rebuilds all bind groups. For 2 M splats that
is ~340 MB down and up plus a JS pass, 70 times a run: on the order of a
minute of a z18 run, doing no training. Either do it every 500 iterations
and only while `grow > 0` (the first 60 %), or move `alive`/`halve`/`jitter`
into WGSL and keep the model resident.

**T2 Iteration counts are SfM-era.** 7 000 / 5 000 iterations exist because
3DGS starts from a sparse point cloud and has to grow the scene. Here the
initialisation is the answer's geometry (`sampleSurfaces` on the mesh that
also produced the frames). Seed at the full budget, not `INIT_SHARE = 0.3`,
drop MCMC growth (keep pruning), and freeze `pos` for the first half. What
is left to learn is colour, opacity and scale, and that converges in the
low thousands: 1 500–2 000 iterations.

**T3 Analytic colour before any gradient step.** Project each training frame
onto the seeded splats (a forward pass already produces `last`/`rest` per
pixel; a scatter of the target colour weighted by `alpha·T` gives a
per-splat mean) and start from that. Seconds, and it removes the part of
training that is only "find the colour".

**T4 Capacity (Q3) is also time**: the per-tile sort is `O(cap log² cap)` in
workgroup memory. A two-level fix — radix sort in global memory over
(tile, depth) keys as reference 3DGS does — lifts the cap and is faster for
full tiles.

**T5 Budgets are larger than the picture.** 2 M at z18 is 8 cm spacing for
a scene whose finest authored content is a 2048² texture on a 60 m object.
Until Q2 lands, 1 M at z18 halves everything with no visible loss. Make
`tile_budget(z)` a ceiling, and let `assemble` ask for what the scene's
triangle count and texture area justify.

**T6 z16 need not be trained.** From 100 m up over a 440 m tile, a lit
sample (`sample-v2`, §4) of an authored scene is indistinguishable from a
trained one, and is hash-verified rather than three-way perceptual. That
halves the fleet's GPU load; train where the player stands (z18).

Estimated z18, one tab, 4070-class card, today: ~40–60 ms/iteration at 2 M
and 512² is 5–7 min, plus T1's minute. With T1–T5: 1 M splats, 1 800
iterations at ~25 ms plus 600 at 1024², about 60–75 s of training; assemble
3 s, frames 10–20 s (split across tabs already), sog 5 s. That is the
"about a minute" target, with T6 taking z16 out of the GPU queue entirely.

## 4. Ray tracing: where it pays

Not in the viewer. Ray-traced gaussians (3DGRT) need RT hardware, have no
browser implementation, and add nothing a player can see at these budgets.
A splat is baked light, so ray tracing belongs in the **bake**, and it
answers Q1, Q2 and Q7 in one place:

**`frame-v2`: WebGPU compute path tracer** replacing the WebGL2 raster in
`render.js`. Same cameras, same `light.js` sun and sky, plus shadows,
sky occlusion and bounce, and base-colour textures sampled at the hit. Two
levels of BVH: one per asset, built once per SAN and cached (the GLB is
content-addressed, so the BVH is too), and a tile-level BVH over instances
plus the terrain mesh. Per-tile geometry is then ~32 k terrain triangles
plus instances; the SPEC's ceiling of 200 objects × 200 k triangles only
costs BVH build time if every asset is unique, which is what the cache is
for. 120 views × 1 M px × 32 spp × ~3 segments ≈ 12 G ray segments; a
compute traversal on a mid-range card does ~1 G/s, so 10–20 s a tile, spread
over the six frame atoms as now. A fixed per-pixel seed keeps two workers'
frames within PSNR of each other; the trainer never needed them bit-equal.
Workers that train already need WebGPU (`caps`), so `frame` requiring it
costs no fleet.

**`sample-v2`: lit baseline** for z14 (and z16 under T6). Per splat, not
per pixel: one sun ray and 16 hemisphere rays against the same tile BVH, on
the CPU in doubles in fixed order, so the ply stays bit-exact and
hash-verified (Invariant 7). 800 k × 17 rays ≈ 14 M rays, a few seconds in
JS. Buildings and trees then shade the ground and each other in every
baseline tile without training anything.

Order: BVH + `sample-v2` first (small, deterministic, immediately visible
everywhere z14 is published); `frame-v2` second.

## 5. Cheap fixes in the trainer (do first, all in `client/lib/gs*`)

1. **Capacity** (Q3/T4): global-memory radix sort keyed on (tile, depth), or
   at minimum raise `CAPACITY` with a chunked in-workgroup sort and count
   the overflow into `result` so an over-capacity run is visible.
2. **Maintenance cadence** (T1): every 500, and only while growing.
3. **Full-budget seed, no growth, frozen positions early; 1 500–2 000
   iterations** (T2): `INIT_SHARE`, `GROW`, `iters` in `0017_verifydag.sql`.
4. **D-SSIM in the loss** (Q4).
5. **Coarse-to-fine** (Q5): 512² then 1024² for the last third, z18 only.
6. **Viewer cap**: `traverse.js LIMITS.splats = 25e6`; the engine sorts on the
   CPU, and 8–12 M is what holds 60 fps on mid-range hardware. Not a bake
   issue, but it is what the player sees.

Each of 1–5 is a training-loop setting or one kernel; none changes the DAG
or the format. Run WP3.1's acceptance on a GPU before and after so the
numbers above become measurements.

## 6. `.r32` — a land's shaped ground (FND.9)

What a player pulls the ground into is a file like any other: immutable,
content-addressed, written once (Invariant 1). One float per cell, **metres
relative to whatever the operator's DEM says is there** — so the operator can
replace the elevation with a better one and everybody's shaping still means
what it meant.

```
offset  bytes  what
0       4      "R32\0"
4       4      the header's length, uint32 little-endian
8       n      the header, JSON, padded with spaces to a multiple of four
8+n     4·w·h  the cells, float32 little-endian, row-major, north row first
```

The header is

```json
{"version": "r32-v1", "bbox": [west, south, east, north], "cell": 0.21,
 "width": 964, "height": 512}
```

`bbox` is the land's own bounding box in degrees; `cell` is the metres one cell
covers, the z18 cell size (512 cells across a z18 tile) unless the land is so
large that the grid would pass 2048 cells across, in which case it is coarser
and the file says so. Written by `client/lib/r32.js`, pointed at by
`height_edit` (db/0141), and read by `client/lib/terrain.js`
`applyHeightEdits`, which samples it bilinearly and ignores every cell outside
the land's own outline.
