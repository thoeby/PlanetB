# Importing your own region

Your map layers, your region. **Not your elevation**: the ground comes from the
coverage the operator picked in Setup, cut one tile at a time when somebody
first walks onto it (`server/splatworld/ground.py`), so there is one elevation
path in this world and not two.

## From the command line

```
splatworld import my-region.json
```

There is no import page any more: `/app/import.html` redirects to the world,
and the server's `/import/*` endpoints are gone with it. A player who has an OSM extract of
their own land copies it into the layers of their QGIS project instead
(`gis/README.md`; story 19, `client/test/run/19-osm-into-land.spec.js`).

Nothing needs GDAL, Node or a shapefile reader: layers arrive as GeoJSON, from
WFS, a file or a table.

## What the world wants from your data

A layer is imported as one kind, and the kinds are OSM's keys (db/0157):
`highway`, `railway`, `aerialway`, `barrier`, `waterway` (lines), `building`,
`landuse`, `natural` (polygons), `natural_point` (points), and `terrainmod`.
Which one a feature is, is a property of the same name: a row says
`landuse=forest`. What a kind may say is the vocabulary (Settings →
Vocabulary).

Two ways a column reaches a feature. `props` maps the world's name to your
column: `{"landuse": "nutzung"}` makes your `nutzung` column the feature's
`landuse`. A value that reads as a number is stored as one (`"12 m"` is 12);
anything else is kept as words. The names and the OSM keys themselves
(`landuse`, `highway`, `building`, …) are always words (`TEXT_PROPS` in
`server/splatworld/importer.py`). `keep` copies columns as they are, under
their own names. Anything else is ignored; it does no harm.

Geometry goes in flat. The world keeps plan geometry at Z = 0 and takes ground
height from your elevation when a tile is compiled, so you never draw in 3D.

## Layers already in a database

A layer can come from a spatial table in this world's own database instead of
a GeoServer. Load your shapefiles or GeoPackages into it once (QGIS:
*Database → DB Manager → Import layer*) and name the table; the geometry is
reprojected on the way in whatever it is stored as. That is a layer with
`table` instead of `typeName`:

```json
{ "name": "forest", "kind": "landuse", "table": "public.wald",
  "props": { "species": "baumart", "age": "alter_j" }, "keep": ["landuse"] }
```

A layer with `file` reads a `.geojson` beside the config instead.

## What the compiler reads off a feature

Nothing is fixed here. A **symbol** decides what a feature becomes, and the
symbols are rows an admin edits in **Settings → Symbols** (db/0161, which
turned the old build rules into them). The first enabled symbol of the
feature's kind (or of `*`) whose conditions all match wins; one with no conditions is the
else-symbol, keep it last.

A symbol is two things:

- **When** — conditions over the feature's own properties:
  `species in ["picea", "fichte"]`, `alter lt 20`, `height exists`. Operators:
  `eq ne in has lt lte gt gte exists missing` (`client/lib/rules.js`). Words
  compare case-blind, and a number sent as text still compares as a number.
- **Layers** — what it lays down: `surface`, `repeat`, `scatter`, `extrude`,
  `place`, `paint`, `check` (`client/lib/symbols.js`). A layer's number is a
  constant or read off the feature:

  ```json
  {"prop": "hoehe", "times": 1, "plus": 0, "min": 2, "max": 80, "else": 6}
  ```

  `else` may be another such object — that is how "the height column, or
  storeys × 3, or 6 m" is said.

Saving a symbol changes nothing anybody sees. **Apply to world** pins every
enabled symbol's version in a `style_version`, marks the tiles it touches
dirty and opens their jobs (db/0162); a tile's snapshot pins the style it was
built with (Invariant 2).

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

  "layers": [
    { "name": "buildings", "kind": "building", "typeName": "myworkspace:buildings",
      "props": { "height": "bldg_hoehe" }, "keep": ["name"] },
    { "name": "roads", "kind": "highway", "typeName": "myworkspace:roads",
      "props": { "width": "breite" }, "keep": ["highway"] }
  ]
}
```

- **`bbox`** — `[west, south, east, north]` in degrees. Leave it out and the
  region is the extent of the layers you imported.
- **`detail`** — the finest zoom compiled here, default 14. Every tile is
  trained, and training wants WebGPU.
- **`owner`** — the account that ends up owning the region, and an admin. Sign
  in as this to compile it. Created on first import.

## Connecting your GeoServer

**Layers** come over WFS. `geoserver.wfs` is the endpoint; each layer names a
`typeName`. GeoServer returns GeoJSON over plain HTTP, which is why this needs
nothing installed. `user`/`password` are optional HTTP basic auth, and any
layer may override them.

To find the values: in the GeoServer admin pages, *Layer Preview* shows each
layer's workspace and name — `myworkspace:buildings` is the `typeName`, and the
WFS endpoint is your GeoServer URL plus `/myworkspace/wfs`.

## What it does

1. Creates the owner account if it is new, and makes it an admin.
2. Creates one `area` per z12 tile the region touches — an area is the unit of
   ownership, and nothing finer than `detail` is compiled inside it.
3. Inserts your features, flattened, made valid, tagged `props.src`
   (`layername:featureid`) so importing the same layer twice changes nothing.
4. Marks every covering tile z6…`detail` as needing a rebuild. That is the
   work queue; the import compiles nothing itself.

Ground the coverage does not reach is the edge of the world, not a hole: the
database refuses to store anything outside it (db/0062_insideground.sql,
db/0140). One imported feature outside it stops the whole import with that
sentence; clip the layer to the ground first. A feature whose interior point
falls in none of the region's areas is skipped.

Re-running after editing a layer in QGIS adds what is new. It does not yet
notice deletions or moved geometry on a feature it has already seen; delete
those rows by `props ->> 'src'` if you need to redo one.

## If the ground fails with an EPSG error

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

Start the server, sign in as the owner, and in **Work** take the render jobs
the pool lists, or turn on **Work in the background** (Work → Settings). Your
browser compiles them.

```
splatworld run
```

`tools/export-world.mjs` freezes the result into a folder you can put on any
web host.
