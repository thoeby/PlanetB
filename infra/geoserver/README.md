# GeoServer — the operator's elevation

GeoServer never serves the app, and nothing here provisions it. The world reads
the operator's elevation from it over WCS, and the server cuts
`/geo/dem/{z}/{x}/{y}.r16` out of that one tile at a time
(`server/splatworld/ground.py`). What to publish and how to point the world at
it: `docs/geoserver.md`.

QGIS no longer draws through GeoServer. It connects to the database as the
player, with a login of its own (`db/0065_playerroles.sql`,
`server/splatworld/qgis.py`, `gis/README.md`). The `geoserver` role with
`BYPASSRLS` and GeoServer's primary-key table `gis.gt_pk_metadata` are gone
(`db/0066_dropproxy.sql`, `REFACTOR-direct-pg.md`); the `gis.*` views are
granted to `player` and read by QGIS directly. The tool that provisioned a
workspace, a PostGIS store and WFS-T layers is gone with them.

In `infra/compose.yml` the container listens on `127.0.0.1:8083`.

## What is left here

- `styles/tile.sld` colours tiles by compile state: red = never published,
  orange = published but dirty, green = current.
- `styles/area.sld` outlines areas and labels them with `detail`.

Nothing in the repository uploads them any more; they are for an operator who
publishes those layers by hand. The QGIS project draws `Tiles` and `Your land`
from the database itself.
