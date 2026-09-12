# GeoServer: the elevation, and nothing else

The world needs one thing from GeoServer: the operator's elevation, published
as a **coverage**, so the server can cut `/geo/dem/{z}/{x}/{y}.r16` out of it
one tile at a time and the viewer has ground to stand on. That is the whole
relationship.

It used to be two things. GeoServer also sat in front of PostgreSQL so QGIS
could draw over WFS-T, which meant a workspace, a PostGIS store, a feature type
per view, a primary-key table, styles, and one database login with `BYPASSRLS`
that every drawn row was attributed to. All of that is gone
(`REFACTOR-direct-pg.md`): QGIS connects to the database as the player.

## What to publish

1. A **coverage store** over your elevation — a GeoTIFF, a COG, or an
   ImageMosaic of a directory of them. `Stores → Add new store → GeoTIFF` (or
   `ImageMosaic`), point it at the file or the directory, publish the layer.
2. That is all. No workspace of ours, no PostGIS store, no styles.

The world reads it over **WCS**. GeoServer serves WCS 1.0.0, 1.1.1 and 2.0.1;
`server/splatworld/ground.py` tries them in turn and remembers which answered.
The WMS of the same coverage is what QGIS draws as a hillshade under your
layers, which needs no configuration either.

## Pointing the world at it

In the page: **Setup → GeoServer**. The address is whatever opens its pages —
`localhost:8081/geoserver`, or the full URL of a workspace. Press **Connect**:
the world asks the WCS what it publishes, and refuses to go on if the answer
is nothing. Pick the coverage in **Ground** and press **Use this ground**.

If the login can read the coverage, it is enough. Nothing is created, nothing
is changed, no admin rights are needed.

## When it will not connect

| it says | it means |
|---|---|
| *could not reach …* | nothing is listening at that address |
| *401* | the user and password are not that GeoServer's |
| *connected, but there is no coverage to stand on* | it publishes no raster with an extent — publish your DEM as a coverage store |
| *… did not answer with XML* | that address is not an OGC service (a proxy, a login page) |

## Without a GeoServer at all

`tools/geoserver-fixture.py` serves one GeoTIFF as a WCS coverage and a WMS
hillshade — the two conversations above and nothing else. It exists so the
player-run can run on a box that cannot pull the container
(`client/test/run/world.js`), and it is a test fixture, not a deployment.
