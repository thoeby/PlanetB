# The player-run's seed data

Dev-box tooling. These scripts fetch the files a player or an operator is
*given* in the player-run (`PLAYER-RUN.md`, TASKS-foundation.md FND.0): one
4 × 4 km cutout around Visp, in Valais — 7.8545–7.9085 °E,
46.2759–46.3119 °N, 2 km each way from the church tower. Nothing here writes
to the database or the file store, and the server still executes no compute
(Invariant 9).

The files are cached here once and gitignored; `client/test/run/world.js` runs
the scripts itself when a file is missing, so `make player-run` needs no step
of its own.

| file | what | tool | source here |
|---|---|---|---|
| `dem-visp.tif` | Copernicus GLO-30 elevation of the cutout, about 1 MB | `tools/make-seed-dem.sh` | real, a range read of the one COG off AWS |
| `osm-visp.gpkg` | OSM shapes of the cutout, layers `lines`, `areas`, `points` | `tools/make-seed-osm.sh` | **stand-in** — Overpass is denied at this egress |
| `tlm-visp.gpkg` | swissTLM3D Bodenbedeckung, one polygon layer, class in `OBJEKTART` | `tools/make-seed-cover.sh` | **stand-in** — `data.geo.admin.ch` is denied |
| `worldcover-visp.tif` | ESA WorldCover 10 m class raster | `tools/make-seed-cover.sh` | real, off AWS |

```sh
bash tools/make-seed-dem.sh      # infra/seed/dem-visp.tif
bash tools/make-seed-osm.sh      # infra/seed/osm-visp.gpkg
bash tools/make-seed-cover.sh    # infra/seed/tlm-visp.gpkg, worldcover-visp.tif
```

`FORCE=1` fetches a file again. All three need `gdalwarp`/`ogr2ogr`
(Debian/Ubuntu `gdal-bin`).

The DEM is the operator's elevation: the player-run publishes it through a
GeoServer — the one at `RUN_GEOSERVER_URL`, the `infra/compose.yml` container,
or, where no registry is reachable, `tools/geoserver-fixture.py` over the same
file, which also publishes the two cover files. The world then cuts its
`/geo/dem` tiles from that on demand (`docs/geoserver.md`).

**Have real OSM of that ground already?** Point the script at it and it takes
it as it is — no download, no stand-in:

```sh
OSM_GPKG=~/visp-osm.gpkg FORCE=1 bash tools/make-seed-osm.sh
```

Any GeoPackage does; the stories want layers `lines`, `areas` and `points`
with OSM's own keys as fields (`highway`, `building`, `landuse`, `natural`,
`barrier`, `waterway`, `lit`, `leaf_type`…), which is what QGIS writes when
you save an Overpass or Geofabrik extract as a GeoPackage.

A stand-in is written by hand in the real source's own shape and keys, over
the same ground, and is deterministic. Each script says on every run which of
the two it produced. **A story that passed against a stand-in has passed
against the stand-in only** — the same rule HANDOFF.md states for the
GeoServer fixture. On a machine that can reach Overpass and swisstopo, the
same scripts write the real thing and nothing else changes.

## Also here

`ch.geojson` — the Swiss border as one polygon, from Natural Earth 1:50m
(public domain). It was the outline of a country-wide seed whose tools are
gone (`docs/seed-ch.md`); nothing reads it now.

## Formats the world stores

**`dem-v2`** — what the server cuts into `/geo/dem/{z}/{x}/{y}.r16`: 512 × 512
float32 metres, little endian, row-major, north-west first, in the tile
projection over exactly the tile's bounds (`server/splatworld/dem.py`).
`dem-v1`, 256 × 256 uint16 with `elevation_m = value * 0.2 - 500`, still
decodes (`client/lib/geo.js` tells them apart by length).

**Features** carry plan geometry at Z = 0; the ground comes from the DEM when
a tile is assembled.
