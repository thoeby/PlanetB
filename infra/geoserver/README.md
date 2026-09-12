# GeoServer — admin and visualisation only

GeoServer never serves the app. The browser talks to PostgREST and nginx;
GeoServer exists so an operator can edit the world in QGIS over WFS-T and see
compile state on a map (Invariant 9).

- `splatworld geoserver <url>` (`server/splatworld/gsprovision.py`) creates the
  `splatworld` workspace, a PostGIS store on the `gis` schema, one layer per
  drawable kind plus `area`, `instance` and the read-only `tile` overview,
  uploads the styles and switches WFS to `COMPLETE` so transactions are
  allowed. It is idempotent, and it ends by reading and writing through what
  it published. The old `provision.sh` published in a different projection
  than the Python and is gone.
- `styles/tile.sld` colours tiles by compile state: red = never published,
  orange = published but dirty, green = current.
- `styles/area.sld` outlines areas and labels them with `detail`.

## Coordinate system

Every layer is declared **and** forced (`FORCE_DECLARED`) in the world SRS —
`world_srid()` in `db/0056_crs.sql`, `crs.WORLD` in the server, the one
place each spells it out. GeoServer serves what Postgres stores and never
guesses a native SRS off a view; `gis.tile` is typed for the same reason. The
QGIS connection is WFS 1.0.0 because from 1.1 on that SRS is latitude-first
and clients and servers disagree about who swaps (`gis/README.md`).

## Role mapping

The store connects as the Postgres login role `geoserver`, created by
`db/0008_admin.sql` with `BYPASSRLS`. That is deliberate and is the only write
path in the system that skips row-level security — it is the admin path, it is
not reachable from a browser, and the role must never be exposed publicly.
Client writes still go through PostgREST and the policies in `db/0003_rls.sql`.

## Layers

The `gis` schema publishes one auto-updatable view per feature kind, each with
a column default for `kind`, so drawing a forest in QGIS inserts
`kind = 'forest'` with no form field. `gis.gt_pk_metadata` tells GeoTools that
`id` identifies a row in those views.
