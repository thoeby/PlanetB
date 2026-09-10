# Drawing the world in QGIS, through your GeoServer

This is the authoring path: you draw, GeoServer writes into the world's
database, the database marks the affected tiles as needing rebuild, and a
browser tab compiles them. Nothing is imported and nothing is copied — the
drawing *is* the world.

## How the pieces fit

```
QGIS  ──WFS-T──▶  GeoServer  ──SQL──▶  PostgreSQL (the world)
                                              │
                                       trigger marks tiles dirty
                                              │
                              browser tab claims the work, compiles, publishes
```

**GeoServer is a translator, not a store.** It holds no data of its own. It
takes WFS requests from QGIS and turns them into SQL against a database you
point it at. Take the database away and GeoServer has nothing.

Three GeoServer words, because they trip everyone up:

- **Workspace** — a namespace. Ours is called `splatworld`. Layer names are
  written `splatworld:feature_road`.
- **Store** (or *data store*) — a connection to where data actually lives. Ours
  is a PostGIS store called `splatworld_pg`, pointing at this world's database,
  at the `gis` schema, connecting as the `geoserver` login role.
- **Layer** (or *feature type*) — one table or view inside that store, published
  for the outside world. We publish eight.

`splatworld geoserver <address>` creates all three for you over GeoServer's REST
API. The rest of this page is what it made, so you can check it, change it, or
do it by hand.

## What gets published

The `gis` schema holds one auto-updatable view per feature kind. Each has a
column default for `kind`, so drawing on `feature_forest` inserts
`kind = 'forest'` without you filling in a field.

| layer | geometry | what it is |
|---|---|---|
| `feature_footprint` | polygon | a building |
| `feature_road` | line | a road |
| `feature_forest` | polygon | woods |
| `feature_water` | polygon | lake, river, pond |
| `feature_terrainmod` | polygon | ground reshaped |
| `area` | polygon | a region somebody owns and may draw in |
| `instance` | point | a placed catalog model |
| `tile` | polygon | **read-only** — compile state |

### Fields on the feature layers

| field | fill it in? | meaning |
|---|---|---|
| `id` | no | uuid, generated |
| `area_id` | **yes** | which `area` this belongs to. The geometry must be inside it |
| `kind` | no | defaulted by the layer you drew on |
| `geom` | you draw it | EPSG:4326 |
| `props` | optional | JSON. `{"height": 12.5}` on a building, `{"width": 7}` on a road. Metres |
| `rev` | no | bumped by a trigger |
| `deleted_at` | no | set instead of deleting, so a tile knows it changed |

`props` is where the two numbers the compiler reads live: **`height`** on a
footprint and **`width`** on a road. Everything else in `props` is yours and is
ignored. In QGIS, set that field's widget to *JSON* or *Text Edit*.

### Fields on `area`

| field | fill it in? | meaning |
|---|---|---|
| `geom` | you draw it | the region |
| `owner_id` | **yes** | the uuid of the account that owns it |
| `detail` | **yes** | finest zoom compiled inside. Use `14` |
| `rules` | optional | JSON, yours |

### `tile`, the one you only look at

Coloured by `status`: **red** never published, **orange** published but stale,
**green** current. Turn it on to watch your edits become work.

## The rule that will bite you

Every feature must lie inside the `area` its `area_id` names. A trigger
(`bump_rev`, `db/0004_tiles.sql`) refuses anything else with:

```
geometry lies outside area <uuid>
```

So **draw an area first**, or use one that exists. A building floating outside
every area is not a thing the world can hold — an area is the promise that this
ground gets drawn at all.

## The awkward part: uuids

`area_id` and `owner_id` are uuids and QGIS will not guess them. The least
painful order:

1. Make an area and an account another way first — the import page's **Make a
   world here** creates both, as does `splatworld import`. Even a 1 km region
   is enough to give you an area to draw in.
2. Find its uuid:
   ```
   psql -d splatworld -c "SELECT id, detail FROM area"
   ```
   Or in QGIS: open the `area` layer's attribute table and read `id`.
3. When you draw a feature, paste that uuid into `area_id`. QGIS remembers the
   last value you typed for a field, so it is once per session, not once per
   building.

If you would rather draw the area itself in QGIS, get your account's uuid with:

```
psql -d splatworld -c "SELECT id, email FROM auth.user"
```

and put it in `owner_id`, with `detail` = 14.

## Doing it by hand in the GeoServer UI

If `splatworld geoserver` fails, or you want to see what it did:

1. **Workspace** — *Data → Workspaces → Add new workspace*. Name `splatworld`,
   any namespace URI.
2. **Store** — *Data → Stores → Add new store → PostGIS*. In the workspace
   `splatworld`, name it `splatworld_pg`, then:
   - *host*: where the database is, usually `localhost`
   - *port*: `5432`
   - *database*: `splatworld`
   - *schema*: **`gis`** — not `public`; the editable views live in `gis`
   - *user*: `geoserver`
   - *passwd*: the `GEOSERVER_DB_PASSWORD` from your `.env` (`geoserver` by
     default)
   - tick **Expose primary keys** — without it WFS-T cannot update a row
3. **Layers** — *Data → Layers → Add a new layer*, pick the store, and
   *Publish* each of the eight. Accept the bounding boxes it computes.
4. **Transactions** — *Services → WFS*. Set **Service Level** to **Complete**.
   Anything less and QGIS can read but never save.

## Connecting QGIS

`splatworld geoserver` writes `gis/splatworld-wfs.xml` pointing at your
endpoint.

1. *Layer → Data Source Manager → WFS / OGC API-Features*
2. **Load Connections**, choose `gis\splatworld-wfs.xml`, then **Connect**
3. Add `area` and the `feature_*` layers you want, plus `tile` to watch

To draw: select the layer, press the pencil (*Toggle Editing*), draw, fill in
`area_id`, then press **Save Layer Edits**. The write reaches the database on
save, not on draw.

## Why this bypasses the security model, deliberately

The store connects as the Postgres role `geoserver`, which has `BYPASSRLS`
(`db/0008_admin.sql`). It is the only write path in the system that skips
row-level security. That is on purpose: it is the operator's door, it is not
reachable from a browser, and **the role must never be exposed publicly**.
Everything a player does still goes through PostgREST and the policies in
`db/0003_rls.sql` (Invariant 6).

GeoServer is admin and visualisation only and is never the app API
(Invariant 9).

## After you draw

Elevation is separate. Drawing gives buildings, roads and water; the *shape of
the ground* under them comes from a DEM, and without one no tile can compile at
all. Either let the import page fetch free Copernicus elevation for your region,
or give `splatworld import` a GeoTIFF of your own (`docs/import.md`).

Then open `/app/play.html`, sign in, tick **work in the background**, and click
**render**. What you drew becomes the world.
