# The pilot region, compiled by a browser tab

![The pilot region as splats](pilot.png)

Three z14 tiles of the pilot — 8.03–8.06 °E, 47.38–47.40 °N, the Aare valley
east of Aarau — seen from 900 m up in `play.html`. Everything in the picture was
produced by one browser tab and published through PostgREST; the server computed
none of it (Invariant 9).

**The picture is historical.** It was drawn by a pipeline that is gone: the
ground came from a Copernicus DEM and Sentinel-2 imagery pre-cut into the store
by seeding tools that no longer exist (`docs/seed-ch.md`), the buildings, pond,
forest and road from an OSM fixture, and the z14 gaussians were sampled from
those surfaces by `sample-v1`, which was removed — every tile is trained now
(`ARCHITECTURE.md` §5). The same spec today compiles something different, and
redraws the picture when it is run.

## Reproducing it

```sh
set -a; . ./.env; set +a
PILOT_BLOCK=1 npx playwright test client/test/e2e/pilot-block.spec.js
```

The spec writes its own world first: `seedGround()` puts a synthetic
`/geo/dem` tile under the block and `seedWorld()` draws an area with a forest
and a gabled house in it (`client/test/e2e/serve.js`). Then it opens
`play.html`, turns the work panel on, calls `ensure_job` for every z14 tile the
world has inside one z12 block and then for the four rungs above it, waits for
each to be published, and finally flies the viewer over the result and writes
`docs/pilot.png`.

`client/test/e2e/pilot.spec.js` is the same thing in the gate, cut down to one
z14 tile and its ancestors. It trains, so it skips on a software adapter.

## What the viewer will and will not refine into

A tile refines into whichever of its children are published, and is not drawn
under them: a tile with children is only ever merged from them, so it holds
nothing they do not hold better (`client/js/traverse.js`). It stays under them
only for a published child whose load failed, until the retry. A dirty parent
is older than the children it was merged from, so its children are drawn
instead at any distance until the merge is redone.
