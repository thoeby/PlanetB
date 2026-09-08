# QGIS admin path

QGIS edits the world over WFS-T against GeoServer, which writes straight into
Postgres as the `geoserver` role. Nothing about this path touches the browser
API: it is the operator's door, and it is the only write path that bypasses
row-level security (see `infra/geoserver/README.md`).

## Setup

1. `make up` (or start the compose stack), then
   `bash infra/geoserver/provision.sh`.
2. In QGIS: *Data Source Manager → WFS / OGC API-Features → Load Connections*
   and pick `gis/splatworld-wfs.xml`. Connect, then add:
   - `splatworld:feature_road`, `feature_forest`, `feature_water`,
     `feature_footprint`, `feature_terrainmod` — editable
   - `splatworld:area`, `splatworld:instance` — editable
   - `splatworld:tile` — read-only compile state (red unpublished, orange
     stale, green current)
3. Save the project as `gis/splatworld.qgz` next to this file, with the layer
   order above and the `props` field set to a JSON edit widget on each feature
   layer.

`gis/splatworld.qgz` is not committed yet: it is a QGIS binary project and has
to be produced and saved by QGIS itself. Everything it needs — the connection
file, the layers, the styles — is in this repo; step 3 is the only manual part.

## Acceptance checklist (WP0.11, manual gate)

Tick each line after running it; this is the WP0.11 gate together with
`make api-test`.

- [ ] `bash infra/geoserver/provision.sh` reports 2xx (or 401/409 for objects
      that already exist) for the workspace, store, every layer and the WFS
      settings.
- [ ] `GET http://localhost:8081/geoserver/splatworld/wfs?service=WFS&request=GetCapabilities`
      lists all eight layers and advertises `Transaction`.
- [ ] In QGIS, draw a polygon on `feature_forest` inside an existing area and
      commit the layer.
- [ ] `GET http://localhost:3000/feature?kind=eq.forest` returns the same
      geometry through PostgREST (compare with `ST_AsText`).
- [ ] `GET http://localhost:3000/tile?dirty=is.true` now lists the z6…z14 tiles
      covering that polygon — the trigger fired for a WFS-T write exactly as it
      does for an API write.
- [ ] Drawing outside every area is rejected with
      `geometry lies outside area …`.
- [ ] `splatworld:tile` in QGIS shows those tiles orange or red after the edit.
