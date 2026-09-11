# Drawing the world in QGIS

The world's land — its roads, woods, water, single trees and terrain edits — is
drawn in QGIS over WFS-T against the operator's GeoServer. This is the operator's
door: it is the one write path that does not go through row-level security, which
is why it is a separate database login (`infra/geoserver/README.md`).

## The project

`splatworld.qgs` is in this folder. Open it in QGIS and everything is there.

It is **generated**, not hand-kept: the layers come from what the world says it
holds (`kind`), and the fields on each form come from what an admin has defined
those kinds may say (`property`, the Admin tab of the world). Add a kind or a
property and rewrite the project with

    splatworld qgis

The connection is pinned to **WFS 1.0.0**. In 1.1 and 2.0 QGIS and GeoServer
disagree about which of the two numbers in `EPSG:4326` comes first, and
everything drawn ends up in the Indian Ocean. Do not change it.

## First time

1. Set the world up in the browser (the Setup tab): your account, your GeoServer,
   and the coverage the world stands on. That publishes the layers.
2. `splatworld qgis`
3. Open `gis/splatworld.qgs`.

## Checklist — tick these on a real QGIS

This is the part no test here can do. `splatworld geoserver <url>` checks the
server end by writing through it; these are the five things only a person with
QGIS open can confirm.

- [ ] The project opens and lists the layers: your land, one per kind, what is
      placed, the tiles, and the ground underneath.
- [ ] Drawing an area and saving it puts a row in `area` — the world's Setup tab
      shows it under Your land.
- [ ] Drawing a wood inside it and saving it puts a row in `feature`, and the
      form offered the leaf type as a dropdown rather than a free-text box.
- [ ] The tiles the wood covers turn dirty (the Tiles layer, or the world's
      Render pool tab).
- [ ] Right-clicking a piece of land offers **Visit in splatworld**, and it
      opens the world standing on that land.
