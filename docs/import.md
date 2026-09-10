# Importing your own region

Your elevation, your map layers, your region. Nothing here is tied to the pilot
or to OpenStreetMap.

```sh
node tools/import-layers.mjs my-region.json
```

## What the world wants from your data

Five kinds, and two properties between them. Everything else you draw is
decoration the compiler ignores — keep it if you like, it does no harm.

| kind | geometry | property it reads |
|---|---|---|
| `footprint` | polygon | `height`, metres |
| `road` | line | `width`, metres |
| `forest` | polygon | — |
| `water` | polygon | — |
| `terrainmod` | polygon | — |

Geometry goes in flat. The world keeps plan geometry at Z = 0 and takes the
ground height from the elevation data when a tile is compiled, so you never
draw in 3D.

## The config file

```json
{
  "owner": { "email": "me@example.com", "password": "pick-something" },
  "detail": 14,
  "layers": [
    {
      "name": "buildings",
      "kind": "footprint",
      "wfs": "https://gis.example.com/geoserver/myworkspace/wfs",
      "typeName": "myworkspace:buildings",
      "user": "admin",
      "password": "…",
      "props": { "height": "bldg_hoehe" },
      "keep": ["name"]
    },
    {
      "name": "roads",
      "kind": "road",
      "file": "./roads.geojson",
      "props": { "width": "breite" }
    }
  ]
}
```

- **`wfs` + `typeName`** — a GeoServer layer. It is fetched with WFS
  `GetFeature` as GeoJSON over plain HTTP, so nothing needs GDAL or a shapefile
  reader installed. `user`/`password` are optional HTTP basic auth.
- **`file`** — a `.geojson` file instead, path relative to the config file.
- **`props`** — `"height": "bldg_hoehe"` means *the world's `height` comes from
  your `bldg_hoehe` column*. Values are read as metres and parsed leniently:
  `"12.5"`, `"8 m"` and `"7,5"` all work.
- **`keep`** — extra attributes to carry through untouched, for your own use.
- **`owner`** — the account that ends up owning the region. Sign in as this in
  the viewer to compile it. Created on first import.
- **`detail`** — the finest zoom compiled inside this region. 14 is the
  baseline; 16 and 18 are trained tiles and want a real GPU.
- **`bbox`** — `[west, south, east, north]`, optional. Left out, the region is
  the extent of everything you imported.

## What it does

1. Creates the owner account if it is new, and makes it an admin.
2. Creates one `area` per z12 tile the region touches — an area is the unit of
   ownership, and nothing finer than `detail` is compiled inside it.
3. Inserts your features, flattened, made valid, and tagged with `props.src`
   (`layername:featureid`) so importing the same layer twice changes nothing.
4. The database marks every covering tile z6…z14 as needing a rebuild. That is
   the work queue — the import itself compiles nothing.

Re-running after you edit a layer in QGIS adds what is new. It does not yet
notice deletions or changed geometry on a feature it has already seen; delete
those rows by `props ->> 'src'` if you need to redo one.

## Then what

Elevation for the same region — `tools/seed-dem.sh` with `DEM_SRC` pointing at
any GDAL dataset, including your own GeoTIFF (`docs/manual.md` §4). Then open
the viewer, sign in as the owner, and turn on background work: the tiles
compile in the browser. `tools/export-world.mjs` freezes the result into a
folder you can put on any web host.
