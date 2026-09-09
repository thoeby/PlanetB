# Seeding Switzerland

The pilot is one z10 tile. This is the same seed over a country: 41 285 km²,
about 15 k z14 tiles, one system area per z12 tile at detail 14.

Everything here is dev-box tooling. It cuts inputs into the immutable file
store and records them in Postgres; not one splat is drawn by the server
(Invariant 9).

## What the region is

`infra/seed/ch.geojson` — the Swiss border as one polygon, 187 points, taken
from Natural Earth 1:50m `admin_0_countries` (public domain, `nvkelso/natural-earth-vector`,
feature `ADM0_A3 = CHE`). PostGIS puts its area at 41 316 km², 31 km² over the
official 41 285: the outline is a national border at 1:50 m, not a cadastre.

Any other outline works the same way:

```
REGION_GEOJSON=infra/seed/at.geojson bash tools/seed-ch.sh
```

The region replaces the pilot tile everywhere `geo_tiles()` is read
(`tools/geo-common.sh`), so `seed-dem.sh` and `seed-ortho.sh` cut the country
without knowing that is what they are doing.

## What it makes

| zoom | tiles | what they are |
|------|-------|---------------|
| z6   | 1     | the whole country in one tile |
| z8   | 10    | |
| z10  | 83    | |
| z12  | 1 037 | one system `area` each, detail 14 |
| z14  | 15 222 | the baseline: what a background tab renders |

16 353 tile rows, all `dirty`, all at `expected_version = 1`, so `ensure_job`
opens a job on any of them.

## Running it

```
set -a; . ./.env; set +a

bash tools/seed-ch.sh                    # areas and tile rows only — seconds
SEED_GEO=1 bash tools/seed-ch.sh         # ... and the DEM and ortho tiles
OSM_FILE=switzerland-latest.osm.pbf bash tools/seed-ch.sh   # ... and the features
```

Each step is resumable: a raster tile already in the store is skipped and
re-registered, an area is keyed by its z12 tile, and a tile row that exists is
left alone. Re-running after an interruption is the recovery procedure.

## Sizes and timings

Measured here, on this repo's dev container, by cutting 4 and then 16 z14 tiles
of the pilot with the sources streamed over HTTP (`DEM_STREAM=1`,
`ORTHO_STREAM=1`) and taking the slope, so the fixed cost of building the source
mosaic is not counted 16 353 times:

| step | fixed | per tile | × 16 353 tiles |
|------|-------|----------|----------------|
| DEM (`dem-v1`, 256×256 uint16) | 3 s | 2.5 s, 131 072 B | ~11 h, 2.0 GiB |
| ortho (`ortho-v1`, 512×512 WebP q85) | 9 s | 5.3 s, ~22.8 kB | ~24 h, ~370 MB |
| OSM (`switzerland-latest.osm.pbf`) | — | — | 450 MB in |
| areas and tile rows | — | — | seconds |

Only the last row has been run for the whole country here; the raster rows are
one region's measured cost multiplied out. `tools/seed-test.sh` runs the region
seed end to end over one z12 tile on every `make api-test`.

Both raster steps are HTTP-bound, not CPU-bound: the 16-tile DEM run spent 43 s
of wall clock and 2.1 s of CPU. So the two things to beat are the network and
the serialism, not the machine:

- cache the sources (`DEM_STREAM=0`, the default) and the per-tile cost is a
  local `gdalwarp`; it costs ~30 GB of `infra/seed/cache` for Switzerland.
- the seed is resumable and keyed by tile, so several processes over disjoint
  `REGION_GEOJSON` slices is the way to use more than one core.
- `FORCE=1` re-cuts what is already there; without it a second run only
  re-registers.

Sources, in the order the tools prefer them:

- DEM — `DEM_SRC` (any GDAL dataset), else `SWISSALTI_VRT` laid over
  Copernicus GLO-30, else Copernicus alone. Switzerland touches 15 one-degree
  Copernicus cells.
- ortho — `ORTHO_SRC`, else Sentinel-2 L2A true colour. One MGRS square does not
  cover the country: pass a mosaic as `ORTHO_SRC`, or run the seed once per
  square with `S2_SQUARE` set and let the store fill in.
- OSM — `OSM_FILE` on disk, else `OSM_URL` (the Geofabrik Switzerland extract).

## What is not seeded

z16 and z18 are pockets, not a baseline: they exist where an `area` raises
`detail`, and the trained tiles that fill them are somebody's bounty. Seeding
all of Switzerland at z16 would be 244 k tiles and is not what the world is for.
