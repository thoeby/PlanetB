# PLAN-lod.md — detail inside a tile, not only between tiles

Read after `ARCHITECTURE.md` §2. This plans a change to it: today the whole of
LOD is the zoom ladder, and the unit of detail is a whole tile.

## What is true now

`traverse.js` is already a screen-space-error refiner — error against camera
distance, 1.4x hysteresis so movement does not thrash it, nearest first, a
20 s grace for looking around. What it lacks is granularity. The atom is a
tile: standing at the edge of a z14 you hold all 800 000 of its splats,
including the ones 1.7 km behind you. `applyCaps` then *skips whole tiles*
that do not fit `LIMITS.splats` (12 M on WebGPU, 4 M on WebGL2), so the ground
at the edge of the view disappears rather than coarsening. At 800 k a tile
that is fifteen tiles, about 6.5 km of z14 ground.

## What the engine already does

PlayCanvas 2.22, which `tools/vendor.sh` pins, ships `scene/gsplat-unified`:
an octree LOD with per-node level selection and a global splat budget. Read
off its source, not its documentation:

- `framework/parsers/gsplat-octree.js:10` claims any asset whose basename is
  **`lod-meta.json`**.
- That JSON is `{ lodLevels, filenames: [...], tree: { bound, children | lods } }`,
  where a leaf's `lods` maps a level index to `{ file, offset, count }`.
  `gsplat-octree.js:144 _extractLeafNodes` collects anything with a `lods`
  key, so **a root that is itself a leaf is a valid tree** — no spatial
  subdivision is needed to begin.
- The files named are **ordinary SOG bundles**. `client/lib/sogenc.js` already
  writes them.
- `gsplat-octree-instance.js:369` turns a level into the interval
  `[offset, offset + count - 1]`. A level is therefore **one contiguous run of
  splats inside its file**.
- Each frame `gsplat-octree-instance.js` scores every node by camera distance,
  FOV, the node's bounding-sphere radius and a `lodBehindPenalty` for what is
  behind you; `gsplat-budget-balancer.js` spends `splatBudget` (default 1 M)
  across nodes by that score. `lodMode` is `error` (default) or `distance`.
- `GSplatComponent#unified` already defaults to true, and the legacy renderer
  carries a removal notice. Our tiles go through this system today — as
  single-level assets, so the balancer has nothing to trade.
- Intervals are handled on **both** paths: the WGSL compute compaction
  (`gsplat-interval-compaction.js`) and the CPU sort worker
  (`gsplat-unified-sort-worker.js`) that WebGL2 falls back to. LOD is not
  WebGPU-only.

## The one thing that makes this cheap

A level is a contiguous run. If a tile's splats are ordered so that **every
prefix is a fair sample of the whole**, then level *i* is simply
`{ file: 0, offset: 0, count: n_i }` — one file per tile, no repacking, no
duplicate splats, and the levels are nested by construction so nothing pops
that was not already there.

That ordering is not a new idea here: `client/atoms/train.js:235` already
shuffles its seed "so any prefix is a fair sample", and `client/lib/preview.js`
reads a prefix for the run's picture. The trained output is not ordered that
way yet; it comes back in brush's order.

A shuffle is the correct first version and a poor last one: a random subset of
a surface leaves holes, which read as thin ground at distance. The step after
is an ordering that keeps spatial coverage at every prefix (a Poisson-disk or
farthest-point walk over the trained splats), which is deterministic from the
same input and so keeps Invariant 7 for merged tiles.

## Steps

1. **Order the trained splats so every prefix is fair.** In `train.js`, after
   `keep`/`widen`, before `pack`. Shuffled from the atom's own seed first.
   `algo_version` goes to `train-v9`: the bytes change.
2. **Write `lod-meta.json` beside the `.sog`.** In the `sog` atom, which
   already writes `height.r16` and `colliders.json` into `/tiles/{z}/{x}/{y}/`.
   One leaf, `bound` from the ply's bbox, levels at a sixteenth, a quarter and
   all of the count. It is derived entirely from what the atom already has.
3. **Point the viewer at it.** `tiles.js:129` builds the `.sog` url; it would
   build the `lod-meta.json` url instead, and `play.html` would set
   `app.scene.gsplat.splatBudget` and `lodMode`. `LIMITS.splats` and the
   skipping half of `applyCaps` become dead once the balancer is doing that
   work, and should be deleted rather than left to fight it.

Steps 1 and 2 are producer-side and provable without a GPU: the levels are
prefixes, so a test can assert that level *i*'s count is a prefix of level
*i+1*'s and that the meta names counts the ply actually holds. Step 3 is the
only one that needs a browser to believe.

## What this is not

It does not replace the zoom ladder. z6…z18 stay: they are how a world that
does not fit in memory is *stored* and how merging works. This is what happens
inside one tile once it is on screen, which is the part the ladder cannot
express.

## Open, and not to be guessed at

- Whether one octree per tile (one leaf) or one per region (a leaf per tile,
  trading across them) is the right unit. The second is what would retire
  `applyCaps` entirely, and it needs a producer that spans tiles — which the
  merge atom already does for z <= 12.
- What `lodErrors` / per-level `errors` do to selection versus the derived
  default. Unread.
