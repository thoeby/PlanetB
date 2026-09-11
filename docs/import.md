# Importing your own region

Your elevation, your map layers, your region.

## The page

```
splatworld run
```

then open **<http://localhost:8080/app/import.html>** (the setup page links to
it). Choose where your layers are — a GeoServer, or this world's own database —
press Connect, and it lists what is there: pick which
layer is which from the dropdowns, pick your elevation raster, press Import.
The region is filled in from the layers you chose. No config file.

The page only answers a browser on the same machine, even when the server is
bound to `0.0.0.0` for other people to look at the world: importing writes to
the world with the owner's authority.

The rest of this page is the same thing from the command line, which takes a
config file and is what the page builds for you (press *Show me the config* to
see it).

```
splatworld import my-region.json
```

Nothing needs GDAL, Node or a shapefile reader. Elevation is read with
rasterio, whose wheels carry their own GDAL.

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

## Layers already in a database

The import page has two sources. **A GeoServer** lists what it publishes over
WFS (and rasters over WCS). **This world's own database** lists every spatial
table Postgres can see — everything except the world's own `area`, `feature`,
`instance` and `tile`. Load your shapefiles or GeoPackages into it once (QGIS:
*Database → DB Manager → Import layer*) and they appear in the list.

A table layer knows its own columns, so the property mapping is a list to pick
from rather than a name to type, and the geometry is reprojected to WGS84 on
the way in whatever it is stored as.

In a config file that is a layer with `table` instead of `typeName`:

```json
{ "name": "forest", "kind": "forest", "table": "public.wald",
  "props": { "species": "baumart", "age": "alter_j" } }
```

## What the compiler reads off a feature

Nothing is fixed here. A **build rule** decides what a feature becomes, and the
rules are rows in `build_rule` you edit in the **Admin tab of the world**
— the same idea as QGIS's rule-based symbology, and the same order: the first
rule whose conditions all match wins, a rule with no conditions is the
else-rule, keep it last.

A rule is two things:

- **When** — conditions over the feature's own properties:
  `species in ["picea", "fichte"]`, `alter lt 20`, `height exists`. Operators:
  `eq ne in has lt lte gt gte exists missing`. Words compare case-blind, and a
  number sent as text still compares as a number.
- **Build** — what it produces. A value is a constant (`0.24`, `"gable"`,
  `[18, 30]`) or a number read off the feature:

  ```json
  {"prop": "hoehe", "times": 1, "plus": 0, "min": 2, "max": 80, "else": 6}
  ```

  `else` may be another such object — that is how "the height column, or
  storeys × 3, or 6 m" is said. `{"prop": "dachform", "text": true}` reads a
  word rather than a number.

What each produced property does:

| kind | property | effect |
|---|---|---|
| `forest` | `height` `[low, high]`, or `height_min`/`height_max` | the range a tree is drawn from |
| | `sides`, `taper`, `color` | the canopy's shape and colour |
| | `mature` | age in years at full height |
| | `age_prop` | which column holds the age (`"alter"`, `"age_years"`, anything) |
| `footprint` | `height` | eaves height in metres |
| | `roof` | `flat`, `gable` or `hip` — which of *your* words means which is the rule's job |
| | `roof_color` | `[r, g, b]` |
| `road` | `width` | carriageway width in metres |
| `terrainmod` | `amount`, `op` | metres, and `flatten`/`raise`/`lower`/`smooth` |

The import page offers exactly the properties your rules mention as things to
map a column to, and anything else can still be carried in by typing its name.
Add a rule that reads `bhd` and `bhd` is mappable, with no code change.

Editing a rule marks **every** tile dirty: a rule is global, and the rule set's
hash is part of every tile's snapshot, so an atom already running knows the
world moved under it.

`db/0037_ruleseed.sql` seeds one set of rules — ten species by latin, german,
french and english name, roofs, and the height fallbacks — so a fresh world
builds something. Every row is yours to change or delete.

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

## If elevation fails with an EPSG error

    CRSError: The EPSG code is unknown. PROJ: proj_create_from_database:
    ...\postgis-3.6\proj\proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2
    whereas a number >= 6 is expected. It comes from another PROJ installation.

Nothing is wrong with the install: PostgreSQL's Windows installer sets
`PROJ_LIB` machine-wide to the PROJ data beside PostGIS, which is older than
the one rasterio carries, and PROJ prefers whatever that variable points at.
The server drops `PROJ_LIB` and `PROJ_DATA` from its own environment before
anything touches rasterio, so this is fixed as of 0.8.1 — if you still see it,
`splatworld doctor` prints one `note: ignoring PROJ_LIB=...` line per variable
it dropped, and the absence of that line means the code running is not this
code (see the copy warning in the same output).

The same variable breaks QGIS, which ships its own PROJ 9 and cannot be told
to ignore it from here. If QGIS reports unknown EPSG codes, remove `PROJ_LIB`
and `PROJ_DATA` from the Windows environment (System Properties → Environment
Variables) and restart it. PostGIS does not read them — it uses the copy it
was built against.

## Then

Start the server, sign in as the owner, tick **work in the background**, and
click **render** on the tiles it lists. Your browser compiles them.

```
splatworld run
```

`tools/export-world.mjs` freezes the result into a folder you can put on any
web host.
