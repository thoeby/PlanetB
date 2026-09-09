# Seeding Switzerland

`tools/seed-ch.sh` seeds a region instead of the pilot's single z10 tile: the
system areas, the tile rows the world promises to draw, and — where the sources
can be reached — the terrain, imagery and OSM behind them. It orchestrates
`tools/seed-dem.sh`, `tools/seed-ortho.sh` and `tools/seed-osm.sh`; it cuts and
inserts nothing itself. Dev-box tooling, like the rest of `tools/`: the server
still executes no compute (Invariant 9).

## Where the outline comes from

`infra/seed/ch.geojson` — the Swiss border as one polygon, 187 points, taken
from Natural Earth 1:50m `admin_0_countries` (public domain,
`nvkelso/natural-earth-vector`, feature `ADM0_A3 = CHE`). PostGIS puts its area
at 41 316 km², 31 km² over the official 41 285: it is a national border at
1:50 m, not a cadastre. Its envelope is 5.970 45.830 10.455 47.776.

Any other outline works the same way — `REGION_GEOJSON=infra/seed/at.geojson` —
because the region replaces the pilot tile everywhere `geo_tiles()` is read
(`tools/geo-common.sh`), so `seed-dem.sh` and `seed-ortho.sh` cut a country
without knowing that is what they are doing.

## What Switzerland is, in tiles

From `tiles_for_geom()` over that outline — the same function the dirty trigger
uses, so a seeded tile and a dirtied one are the same tile:

| z | tiles | edge at 46 °N | what it is |
|---|---|---|---|
| 6 | 1 | 435 km | merge of its children |
| 8 | 10 | 109 km | merge |
| 10 | 83 | 27 km | merge |
| 12 | 1 037 | 6.8 km | merge |
| 14 | **15 222** | 1.7 km | assemble → sample → sog, the baseline |
| | **16 353** | | |

15 222 is the ~14 k z14 tiles WP5.1 asks for. The arithmetic: a z14 tile is
2446 m square in Web Mercator, so 2446·cos φ = 1674 m on the ground at 46.8°,
2.80 km² — 41 316 / 2.80 = 14 750, plus the boundary tiles a 1935 km border
clips, which is the rest.

Use the outline, not its envelope. The envelope rectangle holds **28 140** z14
tiles: 46 % of it is France, Italy, Germany and Austria, and cutting it would
cost 1.7 GB of DEM for ground nobody asked for.

## Running it

```sh
set -a; . ./.env; set +a

DRY_RUN=1 bash tools/seed-ch.sh                   # the plan, and what is missing
bash tools/seed-ch.sh                             # areas and tile rows
SEED_GEO=1 bash tools/seed-ch.sh                  # ... and the rasters
OSM_FILE=infra/seed/cache/switzerland-latest.osm.pbf \
    SEED_GEO=1 bash tools/seed-ch.sh              # ... and OSM
```

One canton, or one valley, without an outline file for it — a box round it,
not its border:

```sh
BBOX=7.0,46.4,7.6,46.8 SEED_NAME=fribourg bash tools/seed-ch.sh
```

`REGION_GEOJSON=<file>` takes a real outline instead — swissBOUNDARIES3D, or
the Geofabrik `.poly` that ships beside the extract, converted to GeoJSON. The
knobs are `REGION_MIN_Z`/`REGION_MAX_Z` (6…14), `GEO_ROOT_Z` (10 — how much of
the region one raster-seed run cuts, and therefore how often progress is
reported), `SEED_NAME`, `FORCE=1` and `DRY_RUN=1`.

## Disk

| | tiles | bytes | measured from |
|---|---|---|---|
| `dem` | 16 353 | **2 044 MiB** | 131 072 B a tile, exactly, at every zoom |
| `ortho` | 16 353 | **402 MiB** | mean 22 767 B over 256 z14 tiles, 66 666 B over 17 coarser ones |

Sources, cached under `infra/seed/cache/` and reused:

| | size | note |
|---|---|---|
| Copernicus GLO-30 | ~760 MB | 18 one-degree cells, N45–N47 × E005–E010, ~42 MB each (measured: 42.9 and 41.7 MB for the two the pilot uses). `seed-dem.sh` derives them from the envelope, so it asks for 18; only 14 hold Swiss land |
| Sentinel-2 TCI | 313 MiB a scene | measured; Switzerland spans ~10 MGRS squares, so ~3 GB — or one swissimage mosaic instead |
| `switzerland-latest.osm.pbf` | ~450 MB | **estimate.** Geofabrik is not reachable from the sandbox this was written in |

2 044 + 402 = **2 446 MiB** in the store, and about **4 GB** of cached sources
on top, so budget 8 GB with room to work.

The z6…z12 rasters are 1 131 of those 16 353 tiles — 141 MiB of DEM, 72 MiB of
ortho, about 7 minutes. Nothing assembles above z14: z ≤ 12 is a `merge` of its
children (`db/0016_sample.sql`). They exist only as the ancestor fallback
`client/lib/geo.js` walks when a finer tile is missing. `REGION_MIN_Z=14` skips
them.

## Time

Rates measured on this box, cutting one z10 root (273 tiles = 1 z10 + 16 z12 +
256 z14) from already-cached sources, then scaled to 16 353 tiles. Scaling is
honest here: the work is one `gdalwarp` per tile and the per-tile cost does not
change with how many tiles there are.

| | measured | per tile | Switzerland |
|---|---|---|---|
| `seed-dem.sh` cutting | 33.1 s / 273 | 0.121 s | **33 min** |
| `seed-ortho.sh` cutting | 73.7 s / 273 | 0.270 s | **1 h 14 min** |
| either, re-run over tiles already cut | 1.74 s / 273 | 0.0064 s | 2 min a kind |

**Cache the sources first.** Those rates are from cached GeoTIFFs. With
`DEM_STREAM=1` / `ORTHO_STREAM=1`, which read the COGs over HTTP range requests
instead, the same work measured 2.5 s and 5.3 s a tile — twenty times slower,
and Switzerland becomes about 11 h and 24 h rather than 33 min and 1 h 14. Both
steps are HTTP-bound, not CPU-bound: a 16-tile streamed DEM run spent 43 s of
wall clock and 2.1 s of CPU. Streaming is right for the one tile
`tools/seed-test.sh` cuts and wrong for a country. Caching costs the ~4 GB in
the table above.

Both raster steps are also embarrassingly parallel and keyed by tile, so
several processes over disjoint `REGION_GEOJSON` slices is how to use more than
one core; the skip-and-re-register rule makes overlapping slices harmless.

| | measured | Switzerland |
|---|---|---|
| areas + tile rows (1 037 areas, 16 353 rows) | **3.4 s**, whole country | 3.4 s |
| the same again | 3.5 s | idempotent, and no cheaper for it |
| `osm2pgsql` reading the extract | not measured — no extract here | **estimate 5–15 min** |
| inserting features | 0.95 ms a row (2 000 rows in 1.90 s) | **estimate 48 min** for ~3 M rows |

So: **a bit over two hours** for the rasters, plus an hour for OSM, plus the
downloads. An evening, not a weekend — and it resumes, so it does not have to be
one sitting.

The two OSM lines are estimates and marked as such. The 0.95 ms is real, and was
measured against a database already holding Switzerland's 1 037 areas and 16 353
tile rows, which is the state the insert actually runs in. How many rows a
Switzerland extract yields — buildings, roads, forest, water — is the part
nobody here could measure; 3 M is a guess from the country's building count.

### The one number that is not arithmetic

The feature insert costs 0.95 ms a row **with JIT off**, and **153 ms a row**
with PostgreSQL's default `jit = on`: 161 times slower, five days instead of
fifty minutes. It is not the trigger. `tiles_for_geom()` builds its candidate
set from three `generate_series`, so the planner estimates 5 000 rows for what
is really five and puts the query's cost at 6.4 × 10⁷ — far over
`jit_above_cost` (100 000). `EXPLAIN (ANALYZE)` on one call:

```
Nested Loop  (cost=1.02..63612736.06 rows=5000) (actual rows=5)
JIT:  Timing: ... Inlining 65.4 ms, Optimization 48.6 ms, Emission 49.9 ms,
      Total 164.9 ms
Execution Time: 182.7 ms
```

165 ms of compiling for 0.15 ms of work, once per inserted feature.
`tools/seed-ch.sh` therefore exports `PGOPTIONS=-c jit=off` for everything it
runs, and says so in its plan. Every statement a seed issues is small; none of
them wants a JIT.

This is not only the seed's problem — every editor write goes through the same
trigger and pays the same 150 ms. Fixing it at the source would be one line in a
new migration (`ALTER FUNCTION tiles_for_geom(geometry, int, int) ROWS 8`, so
the estimate stops being 5 000), which is out of WP5.1's scope but should not
stay out of the next one's.

## Sources, and which ones this box could reach

Same story as the pilot (`infra/seed/README.md`, PROGRESS deviation 30):
`data.geo.admin.ch` and `download.geofabrik.de` are refused by the sandbox's
egress proxy; `*.amazonaws.com` is not.

| | preferred | fallback |
|---|---|---|
| DEM | swissALTI3D 2 m (`SWISSALTI_VRT`, or any GDAL dataset in `DEM_SRC`) | Copernicus GLO-30, 18 cells |
| ortho | swissimage 2 m (`ORTHO_SRC`) | Sentinel-2 L2A, **one MGRS square only** |
| OSM | a Geofabrik extract (`OSM_FILE`) | none |

**The Sentinel-2 fallback does not scale to a country.** It picks the least
cloudy scene of one MGRS square, about 110 km across; Switzerland is 350 km.
`seed-ch.sh` refuses rather than cutting nine tenths of the country out of the
wrong scene:

```
not ok - the region spans 10 z8 tiles and the Sentinel-2 fallback covers one
MGRS square (32/T/MT). Set ORTHO_SRC to a mosaic over 5.970020 45.830029
10.454590 47.775635 — a .vrt over swissimage, or over the scenes you want — or
seed one sub-region at a time with S2_SQUARE set for each
```

Build the mosaic with `gdalbuildvrt ch-ortho.vrt scene1.tif scene2.tif …` and
pass it as `ORTHO_SRC`. The DEM has no such limit: `seed-dem.sh` derives the
Copernicus cells from the region's envelope and mosaics them itself.

Every source is checked **before the first write**. A missing one names the file
and the directory and exits non-zero:

```
not ok - no OSM extract at infra/seed/cache/switzerland-latest.osm.pbf and
https://download.geofabrik.de/europe/switzerland-latest.osm.pbf is unreachable.
Download it on a networked box, put it there, and run this again
```

Half a country in the store and nothing in the database is the state this
refuses to reach. It has been reached once already, and cost a re-seed
(PROGRESS deviation 71).

## When a run is interrupted

Run the same command again. Nothing needs cleaning up, and `FORCE=1` is not the
fix — it is how you re-cut tiles you meant to replace.

- **Rasters.** `seed-dem.sh` and `seed-ortho.sh` skip a tile already in the
  store *and register it again anyway*, so a run killed between writing files
  and registering them is repaired by re-running (deviation 71). The cost of
  re-running a finished country is 2 minutes a kind.
- **Areas and tile rows.** Keyed by their z12 tile and by `(z, x, y)`; a second
  run adds only what is new, and does not bump a tile the world already knows.
- **OSM.** `seed-osm.sh`'s feature insert is one transaction: a run that dies
  partway leaves no features *and* no mark. `seed-ch.sh` writes
  `area.rules.osm_extract` — the extract's name and byte count — only after that
  transaction commits, and skips the whole step when every area of the region
  already carries the current signature. A newer extract has a different
  signature and is read again.

```
# seed-ch: osm: every area of the region is already seeded from
#          switzerland-latest.osm.pbf-451236096
```

To split the OSM step into transactions you can afford to lose, seed the region
in slices: `BBOX=…` for each, one after another. Each slice is its own
transaction, and only the areas that exist when `seed-osm.sh` runs receive
features — but each slice re-reads the whole extract, so a slice costs another
`osm2pgsql` pass.

## What the world looks like afterwards

```
# seed-ch: z6: 1 tile rows, 1 dirty
# seed-ch: z8: 10 tile rows, 10 dirty
# seed-ch: z10: 83 tile rows, 83 dirty
# seed-ch: z12: 1037 tile rows, 1037 dirty
# seed-ch: z14: 15222 tile rows, 15222 dirty
# seed-ch: 1037 system areas over the region, 0 of them seeded from an OSM extract
```

1 037 system areas, one per z12 tile, `detail` 14, owned by
`seed@splatworld.local`; 16 353 tile rows, dirty at `expected_version` 1;
`ensure_job()` opens a job on any of them and gets the z14 baseline DAG
(`assemble → sample → sog`). That is the WP5.1 acceptance criterion, and
`tools/seed-ch-test.sh` asserts it.

Three things to know before turning tabs loose on it.

**Seed OSM first, or the first pass is wasted.** The tile rows are marked dirty
at version 1 before any feature exists. Inserting the OSM features afterwards
bumps `expected_version` to 2, which cancels every open job at version 1
(`ensure_job`) — correctly, but a tile compiled in between is compiled from
bare terrain and then compiled again.

**A z14 tile with no feature is not empty.** It is terrain: the DEM with the
ortho draped on it, which is what `sample-v1` turns into 800 k gaussians. Ground
outside the OSM extract's reach still compiles into something worth looking at.

**The viewer gets coarser until a level is finished.** A tile refines only into
children that all exist *and* are all published; a child row that exists and is
unpublished is a hole (`client/js/tiles.js`, `docs/pilot.md`). Before this seed
the world had rows only where the pilot fixture had dirtied them, so the pilot's
ancestors had no unpublished siblings. Afterwards they have ten. **Do not seed
Switzerland into the database `make gate` runs against** — the WP1 and WP2
browser specs assert exact sets of loaded tiles, and they will start failing.
Seed it into a database of its own, or after the gate.

## What is not seeded

z16 and z18 are pockets, not a baseline. They exist where an `area` raises its
`detail`, and the trained tiles that fill them are somebody's bounty
(ARCHITECTURE §5). All of Switzerland at z16 would be 15 222 × 16 = **243 552**
tiles to train, which is not what the world is for. `REGION_MAX_Z` will go
deeper if you ask, and you should not ask for a country.

## Gate

`tools/seed-ch-test.sh` — 29 assertions, about 45 seconds:

- the plan's tile counts are `tiles_for_geom`'s own, Switzerland is ~14 k z14
  tiles, a dry run writes nothing, and the seed runs with JIT off;
- `BBOX` plans the same tiles as a polygon of the same corners, and half a
  `BBOX` is refused;
- an unreachable OSM extract and a country-sized region with no ortho mosaic
  each stop the run, name what to do, and leave the database untouched;
- one system area per z12 tile at detail 14, owned by the seed user; every z14
  tile dirty at version 1; rows at every zoom from 6 to 14; `ensure_job` opens
  the baseline DAG on one; a second run changes nothing;
- one z14 DEM tile is cut into the store and registered, and after deleting the
  `artifact` row a re-run registers it again without cutting it twice;
- the pilot fixture's 7 features land once each, every area remembers the
  extract, and a second run skips it.

It works in a scratch database and a scratch file store of its own, both dropped
on the way out — seeding writes areas and tile rows, and as above, that is not
something to do to the shared world. The raster and OSM halves skip with a
message where the sources or `osm2pgsql` are missing, the same rule
`tools/seed-test.sh` follows.

Not covered, because it could not be run here: a real Geofabrik extract, a
country-sized raster cut, and the two time estimates that depend on them.
