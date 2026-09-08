# Seeding the pilot region

Dev-box tooling. These scripts pre-cut real terrain, imagery and map data into
the immutable file store and the world tables. The server still executes no
compute (Invariant 9) — nothing here runs on it.

The pilot is one z10 tile, **10/534/358**: 7.734–8.086 °E, 47.279–47.517 °N,
about 27 × 18 km of the Swiss plateau and the Jura foothills around Aarau.
DEM and ortho are cut for it at z10, z12 and z14; the z16 tile at its centre,
**16/34208/22944**, is cut deeper so WP3 has a z16/z18 pocket without seeding
4096 tiles for one. Every knob is an environment variable — `PILOT_X`,
`PILOT_MAX_Z`, `DETAIL_Z`, … — and they live in `tools/geo-common.sh`.

```sh
set -a; . ./.env; set +a
bash tools/seed-dem.sh                                  # /geo/dem/{z}/{x}/{y}.r16
bash tools/seed-ortho.sh                                # /geo/ortho/{z}/{x}/{y}.webp
OSM_FILE=switzerland-latest.osm.pbf bash tools/seed-osm.sh   # area + feature rows
```

Downloads land in `infra/seed/cache/` (gitignored) and are reused. `FORCE=1`
re-cuts tiles that are already in the store; without it an existing tile is left
alone, because an artifact is written once and never replaced (Invariant 1).

## What a seed produces

| | tiles | bytes | source |
|---|---|---|---|
| `dem` | 290 | 37 MB | Copernicus GLO-30, AWS open data |
| `ortho` | 290 | 7.4 MB | Sentinel-2 L2A true colour, 10 m, AWS open data |

290 = 1 z10 + 16 z12 + 256 z14 over the pilot, then the detail z16 tile and its
16 z18 children. Cutting them takes about 30 s for the DEM and 80 s for the
ortho once the sources are cached (85 MB of Copernicus, 330 MB of
Sentinel-2). Each tile is registered as an `artifact` (kind `dem` / `ortho`) under the
seed user `seed@splatworld.local`, so `assemble` can name its inputs by hash.

`seed-osm.sh` adds **16 areas** — one per z12 child of the pilot, `detail = 14`,
owned by the seed user — and one `feature` row per road, forest, water body and
building footprint inside them. Inserting those features is what fills `tile`
with dirty rows at z6, z8, z10, z12 and z14: the world the rest of WP2 compiles.

## Formats

**`dem-v1`** — 256 × 256 uint16, row-major, north-west first, EPSG:3857, little
endian. `elevation_m = value * 0.2 - 500`: two decimetres of resolution over
−500…12607 m, finer than GLO-30's own accuracy and enough for any land on Earth.
The file has no header; that line is the format.

**`ortho-v1`** — 512 × 512 lossy WebP, EPSG:3857, north-west first. Over a z14
tile that is 3.3 m/px.

**Features** carry plan geometry at Z = 0; the ground comes from the DEM when
`assemble` runs. `props` keeps what the world needs and drops the rest: a
footprint's `height`, `levels`, `roof` and `use`; a road's `class`, `width`,
`lanes`, `bridge`, `tunnel`; a forest's `leaf_type`; a water body's `water`. Every
row keeps its `osm` id, which is what makes re-seeding idempotent.

## Sources, and which ones this box could reach

`tools/seed-dem.sh` and `tools/seed-ortho.sh` prefer a local high-resolution
source and fall back to global open data:

| | preferred | fallback used here |
|---|---|---|
| DEM | swissALTI3D 2 m (`SWISSALTI_VRT`, or any GDAL dataset in `DEM_SRC`) | Copernicus GLO-30 |
| ortho | swissimage 2 m (`ORTHO_SRC`) | Sentinel-2 L2A, least cloudy scene of `$S2_YEAR/$S2_MONTH` |
| OSM | a Geofabrik extract (`OSM_URL`, `OSM_FILE`) | — |

**`data.geo.admin.ch` and `download.geofabrik.de` are not reachable from the
sandbox this was written in; `*.amazonaws.com` is.** So the DEM and the imagery
in the store are real data for the real pilot region, at 30 m and 10 m rather
than 2 m, and the OSM path has only ever been run against
`infra/seed/pilot-fixture.osm` — a hand-made extract, not a download, holding one
of everything the style maps. Point `OSM_FILE` at a real extract on a networked
box and the same script fills the same tables; `tools/seed-test.sh` is what
proves the mapping.

`DEM_STREAM=1` and `ORTHO_STREAM=1` read the remote sources over HTTP range
requests instead of caching them whole — a few seconds for one tile, which is how
the gate cuts one without downloading 90 MB.

## Gate

`make api-test` runs `tools/seed-test.sh`: it seeds the fixture, asserts the
features, areas and dirty tiles it produces, seeds one z14 DEM and one z14 ortho
tile straight off AWS, and checks both are registered and served with
`Cache-Control: immutable`. The geo half skips rather than fails where the
sources cannot be reached.
