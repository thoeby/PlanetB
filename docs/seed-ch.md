# Seeding Switzerland — retired

There is no longer a tool that seeds a country. `tools/seed-ch.sh` and the
scripts it orchestrated (`seed-dem.sh`, `seed-ortho.sh`, `seed-osm.sh`,
`geo-common.sh`, `seed-ch-test.sh`) are gone, and nothing pre-cuts ground into
the file store any more.

What replaced them:

- **Ground** is the operator's own elevation, published by their GeoServer over
  WCS. The server cuts a `/geo/dem/{z}/{x}/{y}.r16` tile from it the first time
  a browser asks for that tile, and serves the file from then on
  (`server/splatworld/ground.py`). `docs/import.md` says how to point a world at
  it.
- **Map layers** are drawn by players, in the page or in QGIS
  (`gis/README.md`), or imported by the operator (`splatworld import`,
  `docs/import.md`).
- **Test data** for the player-run is one 4 × 4 km cutout around Visp:
  `infra/seed/README.md`.

`infra/seed/ch.geojson` — the Swiss border as one polygon, 187 points, from
Natural Earth 1:50m `admin_0_countries` (public domain) — is still checked in.
Nothing in the repository reads it.
