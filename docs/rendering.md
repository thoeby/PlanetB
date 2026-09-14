# Rendering: where quality and time go, and how to get both back

State as of WP2: z14 baseline tiles are `assemble → sample → sog` (about 20 s a
tile). Trained tiles (z16/z18) exist only as a DAG; `atoms/train.js` is WP3.1.
This is the analysis behind the decisions for WP3: what limits the picture
today, what will limit training, and the plan for ray tracing and for a
compiled tile in about a minute on a decent GPU.

Numbers below are from the code (`client/lib/*`, `db/0005_jobs.sql`) and the
pilot (`docs/pilot.png`). Training times are estimates: no GPU here.

## 1. What limits quality today

| # | cause | where | effect in `pilot.png` |
|---|---|---|---|
| Q1 | Splat colour is interpolated from **terrain vertex colour**, and the terrain grid is 129 posts a tile: 13 m at z14, 3.4 m at z16. The ortho is sampled only at the posts. | `terrain.js terrainMesh`, `assemble.js sampleSurfaces` | the blur. Even the 10 m Sentinel ortho is undersampled at z14; 2 m/10 cm swissimage would be thrown away entirely. |
| Q2 | Uniform-random placement inside triangles, discs at 0.7 × spacing (1σ), α = 1. Random points leave Poisson gaps the gaussian falloff does not cover. | `sampleSurfaces` | the black speckle: the clear colour shows through. |
| Q3 | Input data: GLO-30 (30 m) DEM and Sentinel-2 (10 m) ortho in the sandbox. swissALTI3D (0.5–2 m) and swissimage (0.1–2 m) are the intended inputs and are reachable from a networked box (`tools/seed-*.sh`). | data | the 30 m hill, the 10 m colour. Biggest single lever; no code. |
| Q4 | Lighting is `0.55 + 0.55·max(n·sun,0)`: no shadows, no sky, no occlusion. A splat is baked lighting, so what the frames show is what the tile will ever show. | `render.js FRAG` | flat; buildings and trees do not sit on the ground. |
| Q5 | Geometry is boxes on oriented bounding boxes, cones for trees, flat material colours, no textures. Training cannot add information the frames do not contain. | `props.js` | cartoon at street level, whatever the trainer does. |
| Q6 | Colour is SH band 0 only (`ply.js`, `sogenc.js`): no view dependence. Fine for sampled tiles; a trained z18 wants band 1. | format | glossy surfaces, water, windows look painted. |

Order of value: Q3 > Q1 > Q4 > Q2 > Q5 > Q6. Q1, Q2 and Q4 are cheap.

## 2. What will limit time

Budgets and iterations as wired (`tile_budget`, `build_dag`):

| z | edge | splats | views | iters | note |
|---|---|---|---|---|---|
| 18 | 110 m | 2 M | 120 × 1024² | 7 000 | 165 splats/m², 8 cm spacing: 25× denser than a 2 m ortho, ~1 per pixel of a 10 cm one |
| 16 | 440 m | 600 k | 56 × 1024² | 5 000 | |
| 14 | 1.7 km | 800 k | – | – | sampled, ~20 s today |

3DGS cost is ≈ iters × pixels × (visible gaussians). At 2 M gaussians and 1024²
a WebGPU kernel is in the 30–80 ms/iter range on a 4070-class card, so 7 000
iters is 4–9 minutes: TASKS.md's "< 8 min" and far from one minute. Where the
time is recoverable:

- **T1 Start from the answer, not from 30 % of it.** We own the geometry; SfM
  projects do not. Seed at the full budget on the surface (what `sample-v1`
  already produces), turn MCMC growth off, freeze positions for the first half
  of training and give them a small learning rate after. Trains colour, opacity
  and scale, which converge in the low thousands of iterations. Estimate: 1 500
  iters instead of 7 000.
- **T2 Analytic colour first.** Before any gradient step, project every frame
  onto the seeded splats and average (a visibility-weighted splat colour). That
  is seconds, and the trainer then only polishes. With T1 this is the single
  biggest cut.
- **T3 Coarse to fine.** 512² for the first two thirds of the iterations, 1024²
  for the rest. Roughly halves pixel work.
- **T4 Budget follows data resolution.** At 2 m imagery a z18 tile needs far
  fewer than 2 M; at 10 cm it needs them. Make `tile_budget` a function of the
  seeded ortho resolution instead of a constant.
- **T5 Do not train z16.** From 100 m up, a lit sample (§3, `sample-v2`) is not
  distinguishable from a trained tile of a box-and-cone scene, and it is
  hash-verified instead of three-way perceptual. Halves the fleet's training
  load; train only where the player stands (z18).
- **T6 Frames are already parallel** (20 views an atom). Ray-traced frames stay
  parallel; nothing to do.

Target for one z18 tile, one tab, decent GPU: assemble 3 s, frames 10–20 s
(path traced, §3), train 30–45 s (T1–T3), sog 5 s, upload. About a minute.
z14 stays at ~20 s.

## 3. Ray tracing: where it pays and where it does not

Ray tracing the *splats* in the viewer (3DGRT-style) needs RT hardware, has no
browser implementation, and gains nothing the player can see at these budgets.
Not that.

Ray tracing belongs in the **bake**, because a splat is baked light (Q4). Two
atoms, one BVH:

**`frame-v2`: WebGPU compute path tracer** replacing the WebGL2 raster in
`lib/render.js`. Scenes are tiny (terrain 32 k tris, a few thousand for
buildings and trees), so a JS-built BVH with a WGSL traversal kernel is enough:
sun with next-event estimation, a sky dome, two bounces, 16–32 spp, fixed
per-pixel seed. 120 views × 1 M px × 32 spp × ~3 segments ≈ 12 G ray segments;
compute traversal on a mid-range card does ~1 G/s, so 10–20 s a tile, split
across tabs as now. Frames then carry shadows, sky occlusion and colour bleed,
and the trained tile inherits them. Workers that train already need WebGPU
(`caps`), so `frame` requiring it costs no fleet. Cross-worker check stays PSNR
(WP2.4) and tolerates the residual noise of a shared seed.

**`sample-v2`: lit baseline.** Per splat, not per pixel: one sun ray and 16
hemisphere rays against the same BVH, on the CPU in doubles, fixed order, so
the result is still bit-exact and hash-verified (Invariant 7). 800 k × 17 rays
is ~14 M rays, 2–3 s in JS. This is what gives z14 (and z16 under T5) shadows
and ambient occlusion without training anything.

What ray tracing cannot fix is Q5: shadows of boxes are still boxes. Pair it
with WP4.1's real GLBs and textured materials, or the bake is faithful to a
cartoon.

## 4. Cheap fixes in the current atoms (do first)

1. **Per-splat ortho lookup** (Q1): in `sampleSurfaces`, a terrain splat samples
   `terrainColour(ortho, u, v)` at its own position; vertex colour stays for the
   other materials. New `assemble-v2`/`sample-v2` algo versions, same DAG.
2. **Stratified placement and scale** (Q2): jittered grid per triangle (or a
   Poisson set from `poly.js scatter`) and 1σ ≈ 1.0–1.2 × spacing; keep α = 1.
   Removes the speckle at no cost.
3. **Grid follows the DEM** (Q1/Q3): `GRID[z]` such that a post is no coarser
   than the DEM pixel, capped at 257 for memory.
4. **SH band 1 in the format** (Q6): `ply.js`, `sogenc.js` (`shN` plane, which
   the engine already reads) for trained tiles only.
5. **Viewer cap** (`tiles.js LIMITS.splats = 25e6`): the engine sorts on the
   CPU; 8–12 M is what keeps 60 fps on mid-range hardware. Not a bake issue
   but it is what the player sees.

## 5. Sequence

WP3.1 as planned, with T1–T3 from the start (they are training-loop settings,
not extra work); §4.1–4.3 as `assemble-v2`/`sample-v2` in the same package;
`frame-v2` path tracer next, `sample-v2` lighting on the same BVH; T4/T5 are
one-line changes to `tile_budget`/`build_dag` once the numbers from a real GPU
are in. Reseed with swisstopo data on a networked box before judging any of it.
