# Drawing the world in QGIS

The world's land — its roads, woods, water, single trees and terrain edits — is
drawn in QGIS, connected straight to the world's database **as you**. Every
policy that decides what you may change in the browser decides it here too
(Invariant 6): your land is yours, somebody else's is theirs, and what you draw
is yours because you drew it.

It went through GeoServer over WFS-T until then, as one database login with
`BYPASSRLS`. That login is gone (`REFACTOR-direct-pg.md`). GeoServer still
publishes the operator's elevation, which is the hillshade under your drawing,
and is asked for nothing else.

## The project

**From the page**: Your land → **Shape this land in QGIS**. It hands you a
`.qgs` with your own database login already in it. Open it; everything is
there. Save in QGIS and the page has it within half a minute.

**From this folder**: `splatworld.qgs` is committed, without anybody's
credentials. It names a PostgreSQL *service* called `splatworld`, so QGIS looks
the connection up in your `~/.pg_service.conf`:

```ini
[splatworld]
host=localhost
port=5432
dbname=splatworld
user=p_<your id, from the page>
password=<what the page showed you once>
```

The page shows the password once, when the login is made. Land → connection
details → **Rotate** makes a new one.

## It is generated, not hand-kept

The layers come from what the world says it holds (`kind`), and the fields on
each form come from what an admin has defined those kinds may say (`property`,
the Admin tab). Add a kind or a property and rewrite the project with

    splatworld qgis

or just download it again from the page, which always writes a fresh one.

## What you can and cannot edit

| layer | |
|---|---|
| Road, Wood, Water, Building, Single tree, Terrain edit | draw, edit, delete — on land you may build on |
| Placed | the products standing on the world; move or delete your own |
| Your land | your boundary, to see. Land is assigned by an admin (SPEC §3.2), not drawn |
| Tiles | what the compiler makes of it, to see |
| Ground (…) | the operator's elevation, as a hillshade, over WMS |

## When a save is refused

QGIS shows what the database said, in the message bar and in the commit
errors — the sentence is the answer:

| it says | it means |
|---|---|
| *that is not your land — Anna owns it* | ask Anna for a build grant (Land → ask for a build grant) |
| *that is not your land — nobody owns the ground there* | ask an admin for land there |
| *… has longitude and latitude swapped* | the geometry arrived the wrong way round; draw it in the project's own CRS |
| *… is outside the world's ground* | the coverage does not reach there; there is no world to draw on |
| *permission denied for view area* | land is assigned, not drawn |
