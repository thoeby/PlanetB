# Importing your own region

Your elevation, your map layers, your region.

```
splatworld import my-region.json
```

Nothing else is needed — no GDAL, no Node, no shapefile reader. Elevation is
read with rasterio, whose wheels carry their own GDAL.

## What the world wants from your data

Five kinds, and two properties between them. Anything else you have drawn is
carried along or ignored; it does no harm.

| kind | geometry | property it reads |
|---|---|---|
| `footprint` | polygon | `height`, metres |
| `road` | line | `width`, metres |
| `forest` | polygon | — |
| `water` | polygon | — |
| `terrainmod` | polygon | — |

Geometry goes in flat. The world keeps plan geometry at Z = 0 and takes ground
height from your elevation when a tile is compiled, so you never draw in 3D.

## The config file

```json
{
  "owner": { "email": "me@example.com", "password": "pick-something" },
  "detail": 14,
  "bbox": [8.035, 47.385, 8.055, 47.395],

  "geoserver": {
    "wfs": "https://gis.example.com/geoserver/myworkspace/wfs",
    "user": "admin",
    "password": "…"
  },

  "elevation": {
    "url": "https://gis.example.com/geoserver/myworkspace/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=myworkspace__dem&format=image/tiff"
  },

  "layers": [
    { "name": "buildings", "kind": "footprint", "typeName": "myworkspace:buildings",
      "props": { "height": "bldg_hoehe" }, "keep": ["name"] },
    { "name": "roads", "kind": "road", "typeName": "myworkspace:roads",
      "props": { "width": "breite" } }
  ]
}
```

- **`bbox`** — `[west, south, east, north]` in degrees. Leave it out and the
  region is the extent of the layers you imported. Give it when you import
  elevation alone.
- **`detail`** — the finest zoom compiled here. 14 is the baseline; 16 and 18
  are trained tiles and want a real GPU.
- **`owner`** — the account that ends up owning the region. Sign in as this to
  compile it. Created on first import.

## Connecting your GeoServer

**Layers** come over WFS. `geoserver.wfs` is the endpoint; each layer names a
`typeName`. GeoServer returns GeoJSON over plain HTTP, which is why this needs
nothing installed. `user`/`password` are optional HTTP basic auth, and any
layer may override them.

To find the values: in the GeoServer admin pages, *Layer Preview* shows each
layer's workspace and name — `myworkspace:buildings` is the `typeName`, and the
WFS endpoint is your GeoServer URL plus `/myworkspace/wfs`.

**Elevation** comes as a GeoTIFF from `elevation.url`, or from a file:

```json
"elevation": { "file": "C:/data/my-dem.tif" }
```

Any raster with a coordinate system works — GeoTIFF, a Cloud-Optimized
GeoTIFF, whatever rasterio can open. It is reprojected and resampled to each
tile for you, so it does not have to be in any particular projection or
resolution.

For a GeoServer coverage, the URL is a WCS `GetCoverage` request asking for
`format=image/tiff`. The exact spelling of `coverageId` differs between
GeoServer versions — 2.0.1 replaces the `:` with `__`. If it comes back as
something other than a GeoTIFF, the importer prints what the server actually
said, which is usually enough to fix the URL. **Not yet tested against a real
GeoServer** — if yours refuses, send me the message and I will fix it.

Easiest check: paste the URL into a browser. If it downloads a `.tif`, it will
work here.

## What it does

1. Creates the owner account if it is new, and makes it an admin.
2. Creates one `area` per z12 tile the region touches — an area is the unit of
   ownership, and nothing finer than `detail` is compiled inside it.
3. Inserts your features, flattened, made valid, tagged `props.src`
   (`layername:featureid`) so importing the same layer twice changes nothing.
4. Cuts elevation into `/geo/dem/{z}/{x}/{y}.r16` — 256×256 uint16 in
   EPSG:3857, `elevation_m = value * 0.2 - 500` — and registers each as an
   artifact.
5. Marks every covering tile z6…z14 as needing a rebuild. That is the work
   queue; the import compiles nothing itself.

Ground your elevation does not cover becomes sea level rather than a hole, and
the importer says how many tiles that was. A tile file already in the store is
left alone unless the new bytes differ, which is an error rather than an
overwrite — a store path is written once (Invariant 1).

Re-running after editing a layer in QGIS adds what is new. It does not yet
notice deletions or moved geometry on a feature it has already seen; delete
those rows by `props ->> 'src'` if you need to redo one.

## Then

Start the server, sign in as the owner, tick **work in the background**, and
click **render** on the tiles it lists. Your browser compiles them.

```
splatworld run
```

`tools/export-world.mjs` freezes the result into a folder you can put on any
web host.
