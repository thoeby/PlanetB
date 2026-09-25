# Refactor — GeoServer serves rasters only; QGIS edits the database directly

Read from branch `claude/wp2-continuation-xs94a7` at cb18a37. File:line refer
to that state.

## Why this, and what it removes

GeoServer does two things today:

1. **Rasters.** `ground.py` cuts DEM tiles from its WCS per tile on demand;
   `qgis.py:127 raster_layer` shows the same coverage as a WMS hillshade in
   QGIS. This stays. It is the only way TBs of DEM work.
2. **A proxy in front of Postgres for QGIS.** `gsprovision.py` (491 lines)
   creates a workspace, a PostGIS store on schema `gis`, a feature type per
   view, `gt_pk_metadata`, styles, and a write probe; QGIS then edits over
   WFS-T 1.0.0; `db/0008` gives the `geoserver` login `BYPASSRLS`; every
   drawn row is attributed to one operator (`gis.default_owner()`, 0058).
   Everything that has broken drawing since 0028 — axis order (0049, 0053,
   0056, 0060), placeholders for blanks (0030, 0032), read-only views
   (0054, 0055), multipart (0057), who owns what you drew (0058) — is
   either caused by this proxy or a workaround for it.

QGIS has a native PostgreSQL provider. It reads the `gis.*` views as they
are, writes through their INSTEAD OF triggers, needs no axis-order pinning,
no placeholder handling, no store, no REST provisioning. And because each
player connects as their own database role, row-level security applies to
QGIS exactly as it does to the browser: your land is yours, no operator
attribution.

Removed: `gsprovision.py`, `test_gsprovision.py`, the GeoServer store and its
DB role, `gt_pk_metadata`, WFS from `qgis.py`, the "provision" step of Setup,
`infra/geoserver/styles` (styles move into the `.qgs`). Nothing a user could
do disappears; drawing gets one connection dialog fewer and becomes
per-player.

Kept unchanged: PostgREST, RLS, the `gis` schema and its views, the
properties → forms generation (0040, 0041), `ground.py`, the compile
pipeline, the pool, permission, catalog, all panels.

## Questions before starting (answer inline; defaults in brackets)

Q1. **Per-player database roles** [yes]. Each player gets `LOGIN` role
    `p_<first 12 hex of uuid>`, password generated once and shown in the
    Land panel with the project download; `auth.current_user_id()` resolves
    it. Alternative: one shared `drawer` role with `SET app.user` — weaker
    and needs a QGIS session hook. Per-player is what makes RLS real.

Q2. **GeoServer login for the DEM** [keep as now: URL + optional user/
    password, stored in `ground`]. Unchanged.

Q3. **`importer.py`** [keep GeoJSON, PostGIS and WFS *sources* for
    importing external data; delete `elevation_source`
    (importer.py:310–342, whole-coverage WCS fetch) since `ground.py` is
    the elevation path]. Say if you still use `splatworld import` for
    elevation anywhere.

Q4. **Committed `gis/splatworld.qgs`** [keep committed, without
    credentials: datasource uses `service=splatworld` so QGIS asks once via
    a pg_service entry; the per-player download from the page carries the
    credentials]. Alternative: stop committing it.

Q5. **GeoServer WMS layers for `gis.tile` / `gis.area`** (the compile-state
    overlay in QGIS) [drop; the same tables are PostGIS layers in the
    project, styled in the `.qgs`]. This is what needed the DB store.

Q6. **`infra/compose.yml`** [GeoServer service stays for rasters; remove its
    link to the database and `GEOSERVER_DB_PASSWORD`].

## Ground rules for the run

- Tag before starting: `git tag pre-direct-pg`. Every step is one commit.
- After every step: `make db-test api-test` green **and** the smoke below
  green on your machine. A step that leaves smoke red is reverted, not
  patched forward.
- No new migration corrects a previous new migration in this run. If step N
  is wrong, `git revert` it.
- Nothing outside the listed files is touched. An agent that "notices"
  something else writes it down and moves on.

### Smoke (run by a human, 5 minutes)

1. `splatworld run` → Setup → GeoServer URL → coverage list → pick → page
   reloads.
2. Land → "Shape this land in QGIS" → download → open in QGIS → the layers
   list; hillshade visible; draw a polygon on `Your land` → Save → no error.
3. Page: Land panel lists the land with your name within 30 s.
4. Draw a forest inside it in QGIS → Save → tile count on the land card
   goes up.
5. Render → Mine → the tiles are listed at the right distance (< 10 km).

Record the result of each line before step S1 (expected today: 1 ✓, 2–5 as
they are for you now) and after every step.

---

## S1 — Land and features are refused outside the ground

*Fixes the "5600 km" failure regardless of transport; needed before the
write path changes so the new path is born with the check.*

`db/0061_insideground.sql`:
- `CREATE FUNCTION inside_ground(g geometry) RETURNS boolean` — true if
  `ground.extent` exists and `st_intersects(extent, g)`.
- `CREATE FUNCTION refuse_outside_ground(g geometry, what text)` — if not
  inside: if `st_intersects(extent, st_flipcoordinates(g))` raise
  `'% has longitude and latitude swapped — draw with the QGIS project
  from the Land panel'`; else raise `'% is outside the world''s ground
  (it reaches %..% E, %..% N)'` with the extent numbers. `errcode 23514`.
- Call it from `gis_area_write()` (0057's current definition — re-create
  the function body with one added line, do not alter the view) and from
  the feature BEFORE trigger `as_lonlat` path (0053) after normalisation,
  and from `instance` writes (0033/0021's insert function).
- `db/test/0061_insideground.sql`: three cases (inside, swapped, outside),
  each asserting the sentence.

Verify: smoke 2 with a polygon drawn with swapped coordinates (type them in
the QGIS vertex tool) → the sentence appears in QGIS.

## S2 — Per-player database roles (Q1)

`db/0062_playerroles.sql`:
- `auth.user` gets `db_role text UNIQUE` and `db_password_hash` is *not*
  stored (the password is shown once and only lives in Postgres).
- `CREATE FUNCTION auth.ensure_db_role(uid uuid, password text)`
  `SECURITY DEFINER`: `CREATE ROLE p_<hex> LOGIN PASSWORD ...` if absent,
  `GRANT player TO p_<hex>` (so every existing `player` policy applies),
  `GRANT USAGE ON SCHEMA gis`, `GRANT SELECT, INSERT, UPDATE, DELETE ON
  ALL TABLES IN SCHEMA gis`, `ALTER DEFAULT PRIVILEGES IN SCHEMA gis …` so
  views generated later (0041 regenerates on property change) are covered.
  Admins additionally `GRANT admin`.
- `auth.current_user_id()` (0002): add a branch — if the JWT claim is
  absent and `current_user LIKE 'p\_%'`, resolve through `auth.user.db_role`.
  Every RLS policy already calls `current_user_id()`, so nothing else
  changes.
- `gis.default_owner()` (0058) → `RETURN auth.current_user_id()`. Delete
  `drawing_as()` and `api.drawing_as()` (the "whose land it becomes"
  guess is gone). `setupui.js:111–130` shows that guess — remove the block.
- The `geoserver` role loses `INSERT/UPDATE/DELETE` on everything (S5
  drops it).
- RPC `api.qgis_credentials()` → for the signed-in player: creates the
  role on first call with a random password, returns `{role, password,
  host, port, dbname}`; every later call returns the role and
  `password: null` plus `rotate: true` support (`api.qgis_rotate()`).
- `db/test/0062_playerroles.sql`: connect as `p_…` (`SET ROLE` in test),
  insert into `gis.area` → `owner_id = that player`; insert into another
  player's land's `f_forest` → refused by RLS.

Verify: `psql -U p_<hex>` → `INSERT INTO gis.area …` → row owned by you.

## S3 — The QGIS project opens PostGIS directly

`server/splatworld/qgis.py`:
- Replace `wfs_source(wfs_url, layer)` (qgis.py:51–61) with
  `pg_source(conn: dict, layer: dict) -> str` returning
  `dbname='…' host='…' port=… user='…' password='…' sslmode=disable
  key='id' srid=4326 type=<MultiPolygon|MultiLineString|Point>
  checkPrimaryKeyUnicity='0' table="gis"."<layer>" (geom)`; geometry type
  from `layer["geometry"]` via `GEOMETRY_NAMES` extended to the Multi
  forms. When `conn["password"]` is `None`, emit `service='splatworld'`
  instead of host/user/password (Q4).
- `map_layer()` (qgis.py:108–125): provider `postgres`, not `WFS`.
- `project_xml(layers, wfs_url, wms_url, …)` → `project_xml(layers, conn,
  wms_url, …)`; the raster layer keeps `wms_url` from `ground.geoserver_url`.
- Add the two read-only layers the store used to style: `gis.tile`
  (categorised renderer on `state`, colours from `infra/geoserver/styles/
  tile.sld` transcribed into `<renderer-v2 type="categorizedSymbol">`) and
  `gis.area` outline; then delete `infra/geoserver/styles/`.
- `write(cfg, out, conn=None)`: the CLI path writes the committed file with
  `service=`; the server path (below) writes with credentials.

`server/splatworld/serve.py`:
- New `GET /qgis/project.qgs` (auth required, `serve.py:282` block): calls
  `api.qgis_credentials()` for the bearer, builds the project with those,
  returns `application/x-qgis-project`, filename
  `splatworld-<name>.qgs`.
- New `GET /qgis/credentials` returning the same JSON for the panel.

`client/js/landui.js` (+ `land.js`): "Shape this land in QGIS" becomes a
download link to `/qgis/project.qgs` plus a collapsed "connection details"
(host, port, db, role, password once; Rotate). The three steps text stays.

`gis/README.md`: rewrite to: download from the page; or Add PostgreSQL
connection by hand with these fields; pg_service example.

Delete: `gsprovision.write_qgis_connection()` (476–491) and its call.

`server/test_qgis.py`: assert provider is `postgres`, datasource carries
`key='id'`, no `WFS` string anywhere, raster layer still `wms`.

Verify: smoke 2–4 with the downloaded project.

## S4 — Setup without provisioning

`client/js/setupui.js`: the GeoServer step keeps URL/user/password and
"Connect", but `provision: false` (setupui.js:92) → rename the button
"Find coverages". Remove the "drawing as" block (S2). Step 2 text: "The
GeoServer that publishes your elevation. Nothing else is asked of it."

`server/splatworld/serve.py:311 /setup/geoserver`: drop the provision
branch; keep probe + coverage listing + `set_ground`.

`client/js/hud.js:49, 75`: wording — "your GeoServer" → "the GeoServer
that serves your elevation".

Verify: smoke 1.

## S5 — Delete the proxy

- `git rm server/splatworld/gsprovision.py server/test_gsprovision.py`.
- `__main__.py`: remove the `provision` command and its help line; keep
  `qgis`, `ground`.
- `config.py:64,125`: remove `geoserver_password` /
  `GEOSERVER_DB_PASSWORD`; `migrate.py:64` stops substituting `:'geopw'`.
- `db/0063_dropproxy.sql`: `DROP TABLE gis.gt_pk_metadata`; `REVOKE ALL
  … FROM geoserver`; `DROP ROLE geoserver` guarded by `IF EXISTS` and by
  no active session; every `GRANT … TO geoserver` in 0028–0060 is left as
  history (grants to a dropped role vanish with it). The `gis` schema and
  views are untouched.
- `infra/compose.yml`: GeoServer service without DB env and without
  `depends_on: postgres`; nginx unchanged.
- `docs/geoserver.md`: one page — what to publish (an ImageMosaic/COG
  coverage store), that nothing else is needed. `docs/manual.md`, `README`,
  `HANDOFF.md`, `ARCHITECTURE.md` Invariant 9: reword "admin path" to
  "QGIS edits the database as the player, under RLS".
- `tools/demo-world.sh`, `tools/ops-test.sh`, `tools/restore.sh`: remove
  the provisioning calls.
- `db/test/0029_gistables.sql`, `0031`, `0032`, `0046`, `0048`, `0055`,
  `0057`, `0058`: any assertion about the `geoserver` role or
  `gt_pk_metadata` is deleted; the rest stays.

Verify: `make gate`; smoke 1–5.

## S6 — Importer (Q3)

`importer.py`: delete `elevation_source` (310–342) and the `"elevation"`
handling in `run_spec`; `coverage_url` in `geoserver.py:162` goes with it.
`docs/import.md`: remove the elevation section. Keep the layer sources.

## S7 — Merge jobs are not offered before their children exist

Not GeoServer-related, but it is the other half of your log. Trace it
rather than patch it:
- `db/0043_pool.sql:37 submit_area` opens a job for every dirty tile from
  z6 down. `0035_mergeready.sql`, `0044_merge_claim_readiness.sql` and
  `0050_fix_claim_for_merge_readiness.sql` are three attempts to keep
  `claim_atom`/`claim_for` from handing out a merge with no published
  child, and your log shows `claim 77 merge → error`, so the third also
  misses a path. Find which `claim_*` function `renderpool.js:20 render()`
  → `work.focus(entry.job)` → `work.step()` calls, and put the readiness
  test in **that** function only, then delete the other two copies.
- `render_pool()` (0043:57) must not list a job none of whose atoms are
  claimable; add the same readiness predicate to its `WHERE`.
- `db/test/0064_mergeready.sql`: a z12 job whose z14 children are not
  published is neither listed by `render_pool()` nor claimable by any
  claim function; publish the children → it is.

Whether a submit should open the coarse jobs at all, or the publish of the
last child should, is your call from the spec (§5.3); S7 only stops the
false offers.

---

## Order and effort

S1 (½ day) → S2 (1 day) → S3 (1 day) → S4 (½) → S5 (½) → S6 (¼) → S7 (½).
Smoke after each. After S5 the repo has ~700 fewer lines in `server/`, one
role fewer, no REST provisioning, and QGIS drawing is per-player under the
same RLS as the browser.

## What I could not verify from the clone

- That QGIS's PostgreSQL provider edits the generated `f_<kind>` views
  cleanly with `key='id'` — it does for views with INSTEAD OF triggers in
  general; step S3's smoke is the proof.
- Whether anything else connects as `geoserver` (a cron, a backup script):
  `grep -r geoserver tools/ infra/` lists `backup.sh`/`restore.sh`; S5
  covers them, check `.env` on your machine.
