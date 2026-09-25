# Drawing the world in QGIS

The world's land — its roads, railways, barriers, waterways, buildings, land
use, nature and single trees — is drawn in QGIS, connected straight to the
world's database **as you**. Every policy that decides what you may change in
the browser decides it here too (Invariant 6): your land is yours, somebody
else's is theirs, and what you draw is yours because you drew it.

It went through GeoServer over WFS-T until then, as one database login with
`BYPASSRLS`. That login is gone (`docs/history/REFACTOR-direct-pg.md`). GeoServer still
publishes the operator's ground layers (the elevation is the hillshade under
your drawing), and is asked for nothing else.

## The project

**From the page**: Your land → **Shape this land in QGIS**. It hands you a
`.qgs` with your own database login already in it. Open it; everything is
there. Save in QGIS and the page has it within half a minute.

**From the command line**: `splatworld qgis` writes `gis/splatworld.qgs` from
the running world's vocabulary (not committed; gitignored). It carries nobody's
credentials: it names a PostgreSQL *service* called `splatworld`, so QGIS looks
the connection up in your `~/.pg_service.conf`:

```ini
[splatworld]
host=localhost
port=5432
dbname=splatworld
user=p_<your id, from the page>
password=<what the page showed you once>
```

The login is minted by the database (`qgis_credentials()`,
`db/0065_playerroles.sql`), and its password is shown once, when it is made.
The project the page hands you always carries one: where the password has
already been shown, the server mints a new one for it
(`/qgis/project.qgs`, `server/splatworld/serve.py`).

## It is generated, not hand-kept

The layers come from what the world says it holds (`kind`, via
`gis_layers()`), and the fields on each form come from what an admin has
defined those kinds may say (`property`, Settings → Vocabulary). Add a kind or
a property and rewrite the project with

    splatworld qgis

or just download it again from the page, which always writes a fresh one.

## What you can and cannot edit

| layer | |
|---|---|
| one per drawable kind: Highway, Railway, Aerialway, Barrier, Waterway, Building, Landuse, Natural, Tree points (and Terrain edit until it is retired) | draw, edit, delete — on land you may build on |
| Placed | the products standing on the world; move or delete your own |
| Your land | your boundary, to see. Land is assigned by an admin (SPEC §3.2), not drawn |
| Tiles | what the compiler makes of it, to see |
| Ground shaping (m) · … | one per land in the world (RLS decides which you may save over): metres above or below the operator's elevation, a raster to edit; saved with `save-ground.py` (`docs/manual.md`) |
| Rendered ground | the published tiles' cover pictures, as an XYZ layer from the file store |
| Ground (…) | the operator's elevation, over WMS |

Shaping the ground is the raster above, not a kind: once Setup → Ground has
converted the old terrain-edit shapes and retired the kind
(`retire_shape_kind()`, db/0165), `terrainmod` has no geometry and no layer.

## When a save is refused

QGIS shows what the database said, in the message bar and in the commit
errors — the sentence is the answer:

| it says | it means |
|---|---|
| *that is not your land — Anna owns it* | ask Anna for a build grant (Land → **Ask to build here**) |
| *that is not your land — nobody owns the ground there* | ask an admin for land there |
| *… has longitude and latitude swapped* | the geometry arrived the wrong way round; draw it in the project's own CRS |
| *… is outside the world's ground* | the coverage does not reach there; there is no world to draw on |
| *permission denied for view area* | land is assigned, not drawn |
