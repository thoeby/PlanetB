# PLAN-lod.md — detail inside a tile, not only between tiles

Read after `ARCHITECTURE.md` §2. This plans a change to it.

## Context

A z14 tile is 1.7 km across and holds up to 800 000 splats. Today the unit of
detail is the whole tile: standing at one edge you hold every splat in it,
including the ones behind you. `applyCaps` (`traverse.js:193`) then *skips*
whole tiles that do not fit `LIMITS.splats` — 12 M on WebGPU, 4 M on WebGL2 —
so the ground at the edge of the view vanishes rather than coarsening. At
800 k that is fifteen tiles, about 6.5 km of z14 ground, and the trade
"crisper tiles" against "see further" has no middle.

`traverse.js` is already a screen-space-error refiner with hysteresis, nearest-
first priority and a grace period for looking around — LOD by world size and
movement, as intended. What it lacks is granularity.

PlayCanvas 2.22, already pinned by `tools/vendor.sh`, ships an octree LOD for
splats (`scene/gsplat-unified/`) with per-node level selection and one global
splat budget. `GSplatComponent#unified` already defaults to true, so our tiles
go through that system today — as single-level assets, giving the balancer
nothing to trade. The outcome wanted here: a tile coarsens instead of
disappearing, and the engine spends one budget across every tile on screen.

## What the engine gives us, read off its source

- `framework/parsers/gsplat-octree.js:10` claims an asset when
  `context.basename === 'lod-meta.json'`. `basename` comes from the asset's
  **declared `filename`** (`handlers/handler.js:61` via `loader.js:107`),
  falling back to the URL. `tiles.js:134` already passes a `filename` distinct
  from its `url`, so a content-addressed URL keeps working. **Invariant 1 is
  untouched and no `can_write` change is needed** — see below.
- The meta is `{ lodLevels, filenames: [...], tree: { bound, lods } }`. A root
  that is itself a leaf is valid (`gsplat-octree.js:144 _extractLeafNodes`).
- **Level 0 is the finest** (`gsplat-octree.resource.js:22` sums `lods[0].count`
  as the total). Higher indices are coarser.
- A level is **one contiguous interval**, `[offset, offset+count-1]`
  (`gsplat-octree-instance.js:369`).
- With no per-level `errors`, the engine derives them as `log(finest/count)`
  (`gsplat-octree.js:106`). **Counts alone suffice.**
- `gsplat-world.js:627` balances **across every octree instance in the scene**
  against one budget. One octree per tile therefore still trades across tiles.
- Intervals are honoured by the CPU-sort worker as well as the WGSL compute
  path, so WebGL2 is supported.
- A node starts at its coarsest level and is *upgraded* as budget allows.

## The one thing that makes this cheap

A level is a contiguous run. Order a tile's splats so that **every prefix is a
fair sample of the whole**, and level *i* is `{ file: 0, offset: 0, count: n_i }`
— one file per tile, no repacking, no duplicated splats, nested by
construction so nothing can pop that was not already there.

`encodeSog`/`fillPlanes` (`sogenc.js:291`) writes splat *i* to texel *i*: the
encoder is order-transparent, so a prefix of the splat array is a prefix of the
texture planes. That is the green light for the whole scheme.

## Where the ordering belongs: `sog`, not `train`

`train`'s output is the obvious place and it is the wrong one.

- Merged tiles (z ≤ 14) never pass through `train`. They come out of
  `merge.js` in **voxel-key scan order** (`Grid.finish`, merge.js:141), and a
  prefix of a scan order is a *stripe of ground* — worse than a shuffle.
  Ordering in `train` would need `merge-v2` as well.
- Both producers pass through `sog`, which is also where the meta has to be
  written anyway (it already hashes its own side-files for `manifest.height`
  and `manifest.colliders`, sog.js:88).
- Cost: `sog-v2` re-sogs every tile, seconds each. `train-v9` + `merge-v2`
  retrains every z16/z18 tile, GPU-minutes each, for the same result. The
  downstream cascade is identical either way.

`sog` is in `deterministic()` (`db/0016_sample.sql:95`) and is hash-compared on
second opinion, so the ordering must obey Invariant 7 in full. It is designed
to (below).

## Steps

Four commits, each green under `make db-test && make client-test && make lint`.

### 1. The ground stays until the splats are there

A live bug fix, valuable alone, and the mechanism the rest needs. Today
`ground.js:27 covered()` removes the ground mesh on `published_version > 0` and
`traverse.js:215 replaced()` reads `entry.entity !== null` as "on screen".
Both are already slightly wrong — a published tile still in flight blanks the
ground — and both become badly wrong under an octree, whose asset is `ready`
when its **JSON** parses, not when its splats arrive.

- `tiles.js`: every entry gains `resident` and `placedAt`, set where `entity`
  is set today. Behaviour identical; the question moves onto its own field.
- `traverse.js`: `replaced()` reads `resident`.
- `ground.js`: `covered()` takes a predicate answering "are that tile's splats
  drawn?"; `DemGround` takes the streamer and asks it.
- `spot.js:121`: spot-check a tile whose bytes are in hand.

### 2. Every prefix of a tile is a fair sample of it

New `client/lib/lodorder.js`, pure library, no atom change.

Written in the style of `merge.js`'s `Grid` (merge.js:83-171) and pointing at
it as the template — but **not reusing it**: `Grid.key` is load-bearing for
`merge-v1`'s bytes, and touching it breaks Invariant 7 for every merged tile.
Share the pattern, not the code.

Nine nested voxel grids over the tile's bbox, level *l* having `2**(l+1)` cells
an axis (2 … 512). A splat's **rank is the coarsest level at which it is its
cell's representative**, the representative being the largest-area splat in the
cell (`max * mid` of its three extents, times alpha), ties broken by index.
Bands are concatenated coarse-to-fine; the prefix property is therefore true by
construction, and asserted anyway.

Determinism, per merge.js:7-11: integer keys packed `< 2**27`; a `Map` used only
as an index, never iterated for the answer; every comparator total with an
integer tiebreak; fixed summation order; no `hypot`/`exp`/`log` anywhere near a
key; squared distances only.

`lodLevelCounts()` picks the published boundaries from where the splats
actually are — each level at most a quarter of the next finer, never thinner
than 256, at most six levels — rather than from three fixed fractions.

Also: `ply.js` gains `permute(f, order)`, and `preview.js`'s `shuffled` is
rebuilt on it so there is one copier in the repo instead of two.

### 3. A tile publishes its levels

- `sog.js` → `sog-v2`: order the splats, encode the permuted set, write a
  second file and `manifest.lod = { sha256, levels }`, exactly as
  `manifest.height` is done today.
- The meta is stored at `/tiles/{z}/{x}/{y}/{sha}.json`, which
  `can_write` (`db/0051_sharedbytes.sql:70`) **already permits**. The fixed name
  `lod-meta.json` exists only as the viewer's declared `filename`. A literal
  `lod-meta.json` path would be refused by `can_write`, and would be written
  once and then 409 for ever while being served `immutable` for a year —
  a silently stale meta. This is the detail that keeps Invariant 1 whole.
- `tree.bound` is rounded to centimetres before stringifying, so no float
  formatting argument can give one tile two shas.
- No `errors` array — the engine derives them from the counts.
- New `db/0134_atilesaysitsownlevels.sql`: artifact kind `'lod'` in the
  `db/0127` pattern, and `build_dag` redefined at `sog-v2`.
- `work.js:24` and `tools/make-test-tiles.mjs` follow the version.

### 4. The viewer spends a budget across the tiles it holds

- `tiles.js` `fileOf(row)`: `manifest.lod` present → the meta URL with
  `filename: 'lod-meta.json'`; absent → today's `.sog`. **The second arm is not
  an operator knob** — it is keyed on published data, like `manifest.height`
  being optional — and it is what stops every existing world going black on
  the day this ships. It is deleted once nothing is older than `sog-v2`.
- `splatsHere(entry)`: one function, naming the engine fields it reads so a
  version bump has one thing to re-check, backstopped by a 10 s timer. The
  engine's loader retries twice and then fails **silently**, so the timer is
  the only backstop there is.
- The swap parks the new entity in the scene and keeps the old one until the
  new one has splats. Two entities briefly overlap — a momentary softening as
  the balancer coarsens both, not the hole `adopt()` would now leave.
- `placeNext()` admits at most `limits.inflight` tiles that are placed but not
  resident. `inflight` stops bounding kilobyte JSON fetches and starts
  bounding megabyte `.sog` fetches.
- `applyCaps` → `applyTileCap`: keeps `limits.tiles`, loses the splat arm.
  `LIMITS.splats` → `LIMITS.splatBudget`, same numbers, handed to
  `app.scene.gsplat.splatBudget` in `play.html` **in the same commit** — and in
  `limitsFor` too, so entering XR moves the budget and not just the flag. The
  number changes meaning from *held* to *drawn*, which is a real relaxation.

## Verification

Per commit, and in this order:

1. `node --test client/test/*.test.js` — the node suite (291 today).
2. `make db-test` — pgTAP, 927 tests over 92 files. Commit 3 adds
   `db/test/0134_*.sql` in the `db/test/0101` shape: the `sog` atom's
   `algo_version` at both a trained and a merged zoom, `register_artifact` with
   kind `'lod'` living, a bogus kind still throwing.
3. `make lint` — sqlfluff over `db`, eslint over `client`.
4. `make player-run` — the fifteen stories. Commit 4 is the one that can break
   it; stories 8 and 9 are the ones that would.

New tests that carry the weight:

- **`client/test/lodorder.test.js`** — the order is a permutation; levels nest;
  each level is a literal prefix of the next; the ranking is the geometry's and
  not the input order's (run it again on a shuffled copy, compare the selected
  sets by position); **and a coverage test**: a coarse prefix's nearest-splat
  distance over a lattice stays under a bound that the same-length prefix of a
  *shuffled* order fails. That last one is the only test that distinguishes
  "spatially fair" from "statistically fair", which is the reason this library
  exists.
- **`client/test/ground.test.js`** — the ground stays under a published tile
  whose splats have not arrived, and under a published-but-absent ancestor.
- **`client/test/tilestream.test.js`** — a row with `manifest.lod` yields the
  meta URL and `filename: 'lod-meta.json'`, a row without yields the `.sog`; a
  swap keeps the old entity until the new one has splats.
- **`client/test/e2e/sog.spec.js`** — a `pc.Asset` built with the meta URL and
  `filename: 'lod-meta.json'` resolves, reports `resource.numSplats`, and is
  accepted by a `gsplat` component. This is the one assertion that proves the
  meta shape against the real engine rather than against a reading of it.
- **`client/test/e2e/lod.spec.js`** (new) — from a viewpoint with several tiles
  in view: fewer splats drawn than the tiles hold, near tiles finer than far
  ones, and no empty frame.

Steps 1-3 are provable without a GPU. Step 4 needs a browser.

## Risks

1. **The coarse levels may read as a sieve. This is the biggest risk in the
   design and the first thing to look at when step 4 lands.** A prefix keeps
   splats at their trained size, so a 1/64 level covers about 1/64 of the
   ground. `merge.js` solves the same problem by inflating a cluster to
   `voxel/2` (merge.js:160) and we cannot — one copy of each splat serves every
   level. Pushing back: the election takes the *largest* splat in each cell, so
   coverage degrades far slower than a uniform subset; the engine floors every
   splat at 2 px (`minPixelSize`); and the level ladder stops before it gets
   absurd. Untested without a GPU and real tiles.
2. **If it does read thin, the fix is a bigger change.** Each coarse level gets
   its own small `.sog` holding its representatives *widened to their cell
   size* — `filenames: [full, lod1, …]`, each level `{file: j, offset: 0}`.
   `lodorder`'s bands are already exactly those sets, so it is an extension and
   not a rewrite; but it multiplies files per publish and changes what "the
   tile's sog" means.
3. **This is a render budget, not a bandwidth budget.** One file per tile means
   the whole tile downloads whenever any of it is visible — the same as today,
   so nothing regresses, but "LOD" should not be read as promising less
   traffic. Risk 2's shape is what would buy that.
4. **`LIMITS.tiles = 64` now means 64 tiles fully resident**, where `applyCaps`
   used to skip the ones that did not fit. A materially larger resident set even
   though fewer splats are drawn. `tiles` may need to come down; no measurement
   yet to say by how much.
5. **The `sog-v2` cascade.** Every tile's `.sog` sha changes, so every merged
   ancestor dirties. No training is involved, but it is a full re-publish of the
   world. There is no zero-cascade option — any reordering changes bytes.
6. **`splatsHere` reads engine internals** (`resource.octree`,
   `getFileResource`). Contained in one function, pinned by a unit test with a
   fake asset, backstopped by the timer. A 2.23 bump re-reads that function.
7. **XR is unproven.** Coverage is evaluated from a single camera node; a
   session draws twice. The e2e test can prove the budget is *set*, not that it
   is *right*.
8. **`lodBehindPenalty` stays at its default of 1** — no penalty for what is
   behind you, which is the waste this whole plan names in its first paragraph.
   Raising it is a one-line experiment after step 4, not part of it.
