# GeoServer — admin and visualisation only

GeoServer never serves the app. The browser talks to PostgREST and nginx;
GeoServer exists so an operator can edit the world in QGIS over WFS-T and see
compile state on a map (Invariant 9).

- `provision.sh` creates the `splatworld` workspace, a PostGIS store on the
  `gis` schema, one layer per editable feature kind plus `area`, `instance` and
  the read-only `tile` overview, uploads the styles and switches WFS to
  `COMPLETE` so transactions are allowed. It is idempotent.
- `styles/tile.sld` colours tiles by compile state: red = never published,
  orange = published but dirty, green = current.
- `styles/area.sld` outlines areas and labels them with `detail`.

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
