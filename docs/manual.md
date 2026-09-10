# splatworld — install, deploy and use

What exists: every task in `TASKS.md`, WP0 through WP5 (`PROGRESS.md`). A world
of real terrain, imagery and OpenStreetMap features is compiled into
Gaussian-splat tiles by browser tabs and streamed back into a first-person
viewer; z16/z18 tiles are trained on WebGPU and verified by three other tabs;
players place catalog models, own areas, grant rights, propose and approve
edits, and pay bounties. Four things are written but unrun for lack of hardware
or data: WP3.1's training acceptance on a real GPU, WP5.4 on a headset, the
full Switzerland raster seed, and WP0.11's QGIS round trip (`HANDOFF.md` §6).

## 1. What runs where

| process | role | port (compose) |
|---|---|---|
| PostgreSQL 16 + PostGIS | the world, jobs, atoms, ledger, auth | 5432 (loopback) |
| PostgREST 12 | the only API (`http://host:3000`) | 3000 (loopback) |
| nginx | immutable file store `/assets /tiles /jobs /geo`, static client under `/app/` | 8080 |
| GeoServer 2.26 | admin/visualisation only, WFS-T for QGIS | 8081 (loopback) |

The server executes no compute. Every atom (assemble, sample, merge, sog,
train, verify) runs in a player's browser tab (Invariant 9). There is no cron
and no worker process; `tools/` are run by a person on a dev or ops box.

## 2. Install

### 2a. With Docker (normal deployment)

```sh
git clone <repo> splatworld && cd splatworld
cp .env.example .env         # change JWT_SECRET (>= 32 chars) and every password
make up                      # postgres, postgrest, nginx, geoserver
make db-reset                # creates the database and applies db/*.sql
```

`make db-reset` connects with the `PG*` values from `.env`; with compose these
are `localhost:5432`, user `postgres`. It drops and recreates the database, so
run it once at install and never on a live world.

Then open `http://localhost:8080/app/play.html`.

`infra/compose.yml` passes `docker compose config` but has not been started on
a box with a Docker daemon; every gate so far ran against the four processes
installed directly (2b). If `make up` needs a fix, commit it.

### 2b. Without Docker (dev box, CI)

Ubuntu 24.04:

```sh
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras webp gdal-bin osm2pgsql rsync
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""
curl -sSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz \
  | tar xJ -C /usr/local/bin
pip3 install sqlfluff
cp .env.example .env
npm install                  # eslint + playwright, tooling only
make vendor                  # PlayCanvas, Draco and OpenLayers copies for the browser tests
set -a; . ./.env; set +a     # tools/ read PG*, JWT_SECRET, FILES_ROOT from the env
make db-reset
```

`nginx-extras` is the build with the DAV module; `nginx-light` cannot PUT.
`tools/api-test.sh`, `tools/files-test.sh` and `tools/test-tiles.sh` start
their own PostgREST and nginx on `$API_URL` / `$FILES_URL` when nothing is
listening. To run the app itself without compose, start them by hand:

```sh
postgrest infra/postgrest.conf                        # needs PGRST_DB_URI, JWT_SECRET in env
nginx -c "$PWD/infra/nginx.conf"                      # after editing root/upstream/listen
python3 -m http.server 8000 --directory client        # or any static server
```

## 3. Configure

All configuration is `.env` (see `.env.example`):

| variable | meaning |
|---|---|
| `JWT_SECRET` | HS256 secret shared by `login()` in the database and PostgREST. Change it. |
| `POSTGRES_PASSWORD`, `AUTHENTICATOR_PASSWORD`, `GEOSERVER_DB_PASSWORD`, `GEOSERVER_ADMIN_PASSWORD` | passwords; change all four |
| `FILES_ROOT` | directory of the immutable file store (default `./infra/files`) |
| `PG*` | where `make` and `tools/` find the database |

The client finds its endpoints in two `<meta>` tags at the top of each page
(`splatworld:api`, `splatworld:files`). Edit them for a deployment that is not
on `localhost`. nginx answers CORS for the store, so the client may be served
from another origin.

Compose binds Postgres, PostgREST and GeoServer to `127.0.0.1`; only the file
store (8080, which also serves the client) listens on all interfaces. For a
public deployment put a TLS proxy in front of 8080 and 3000, and edit the
`<meta>` endpoints accordingly. The `geoserver` database role has `BYPASSRLS`.
It is the operator's door; never expose port 8081 or that role to the internet.

The user `seed@splatworld.local` that the seed tools create is an `admin`
whose password hash is locked; it cannot log in. Create your own admin with
`register()` and `UPDATE auth.user SET role = 'admin'` over psql.

## 4. Seed a region

Dev-box tooling, run once per region. Details and knobs: `infra/seed/README.md`
(the pilot, one z10 tile around Aarau) and `docs/seed-ch.md` (Switzerland).

```sh
set -a; . ./.env; set +a
bash tools/seed-dem.sh                                   # /geo/dem  (Copernicus GLO-30 or swissALTI3D)
bash tools/seed-ortho.sh                                 # /geo/ortho (Sentinel-2 or swissimage)
OSM_FILE=switzerland-latest.osm.pbf bash tools/seed-osm.sh   # features + one area per z12, detail 14
```

For the whole country, `tools/seed-ch.sh` drives the three over
`infra/seed/ch.geojson` a z10 root at a time (`DRY_RUN=1` first; `SEED_GEO=1`
for the rasters, about 2.4 GB). Seeding creates the seed user, the system
areas and the `feature` rows; the trigger marks every covering tile z6…z14
dirty. That is the work queue.

## 5. Use

### Play (`/app/play.html`)

- **Sign in / create account** in the top-left panel. Reading the world needs
  no account; working, building and editing do.
- **Move**: WASD, Space up, Shift down, mouse look after clicking the canvas
  (pointer lock), `F` toggles walk/fly. The ground comes from the finest
  loaded tile's heightmap; colliders block you.
- **Status line**: published tiles, loaded/loading, origin rebases, hot swaps.
  The viewer polls the loaded tiles every 30 s and swaps in new versions.
- The streamer only refines into a tile whose children are all published.
- **Spot check**: when your tab loads a tile someone else published inside an
  area you may write, and you have not checked it for a week, it renders two
  poses and reports the result. A failure marks the tile `suspect`.

### Work panel (same page)

- Shows the GPU this tab has (WebGPU or WebGL2). Training needs WebGPU.
- **My dirty tiles**: tiles you own an area in that need compiling; `render`
  calls `ensure_job` and starts the loop.
- **work in the background**: claim any ready atom, run it in a Web Worker,
  upload to the store, submit, publish. Leave the tab open; it heartbeats
  every 60 s and a claim expires after 5 minutes of silence.
- **help render the world**: restricts claims to the cheap baseline ops
  (`sample`, `merge`, `sog`) nearest to where you stand, paced to keep the
  frame rate. `GET /progress` (public) is the dashboard; the panel shows it.

To compile a region: sign in as the owner of its areas (the seed user cannot
log in; use your own account after inserting an `area`, or an admin), press
`render` on a z14 tile, then on the ancestors once their children are
published. Ancestors are marked dirty automatically when a child publishes.
Each z14 tile is ~20 s of work in a tab. A z16/z18 tile runs assemble, frame,
train (WebGPU, minutes), sog, then waits for three other tabs to verify it.

### Build mode, areas, wallet (same page)

- **build mode** detaches the player; click the ground to place the selected
  catalog asset. Keys: `G`/`R`/`T` move/turn/size, `X`/`Y`/`Z` axis, `]`/`[`
  or arrows step (snapped by default), `Delete` removes, `Ctrl+Z` undoes. A
  placement is an `instance` row; an `edit` grantee's placement becomes a
  proposal instead.
- **areas**: your areas, their grants (`direct_edit`, `edit`, `approve`, by
  email), `approvals needed`, and pending proposals with a diff preview and
  approve/merge.
- **wallet**: balance, ledger, and `set bounty` on the job of the tile you are
  looking at. Escrow is released pro rata by GPU seconds when the tile
  publishes; a cancelled job refunds it.

### Catalog (`/app/catalog.html`)

Search, inspect and upload GLB models. An upload is canonicalised
(`canon-v1`: extensions stripped, Draco decoded, textures capped at 2048 px,
re-centred, deterministic bytes) and gets a SAN, the same one however it was
exported. Near-duplicates are flagged before upload. Licences: `cc0`, `free`,
`paid`, `limited` (editions); `buy_asset` is one transaction with the edition
count as its lock.

### Editor (`/app/edit.html`)

The web GIS editor: OpenLayers over the world's features, drawing and editing
roads, forests, water, footprints and terrain modifiers with property forms.
Writes go through PostgREST and row-level security; a writer's drawing is an
insert, an `edit` grantee's is a proposal. Drawing dirties the covering tiles.

### XR (`/app/play.html?xr=1`)

Lower budgets (8 M splats, 24 tiles), an **enter VR** button, teleport
locomotion by trigger. Not yet run on a headset; `docs/xr.md` is the checklist.

### API (PostgREST)

Tables are read through `security_invoker` views; writes go only through RPCs.
Examples:

```sh
curl -X POST localhost:3000/rpc/register -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}'
TOKEN=$(curl -s -X POST localhost:3000/rpc/login -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}' | tr -d '"')
curl localhost:3000/tile?dirty=is.true                      # anyone
curl localhost:3000/progress                                # anyone
curl -X POST localhost:3000/rpc/ensure_job -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"z":14,"x":8552,"y":5737}'
```

RPCs: `register login ensure_job claim_atom heartbeat submit_atom
submit_verification publish_tile set_bounty pay register_artifact
register_asset similar_assets buy_asset transfer_asset_right propose approve
merge_proposal set_grant revoke_grant set_required_approvals area_grants
my_proposals my_dirty_tiles recheck_atom spot_due can_write`. Row-level
security decides every write; the client has no authority of its own.

### Admin (QGIS)

`make up && make db-reset`, `bash infra/geoserver/provision.sh`, then load
`gis/splatworld-wfs.xml` in QGIS and edit `area`, `feature`, `instance`
over WFS-T. `gis/README.md` has the checklist. `splatworld:tile` shows compile
state (red / orange / green).

## 6. Verify an installation

```sh
make gate         # db-test, api-test, client-test, lint — about 20 minutes
```

`docs/gates.md` lists what each gate covers and when browser tests skip. The
browser tests that compile or train real tiles need the pilot seeded (section
4) and skip otherwise. `make db-test` resets the database: do not run it
against a live world.

## 7. Operations

`docs/runbook.md` is the on-call document. The short form:

- **Backup**: `bash tools/backup.sh /srv/backups` — `pg_dump` first, then
  rsync of `/assets` and `/tiles` hard-linked against the previous run. `/geo`
  is re-cut by the seeds and `/jobs` is scratch; neither is backed up.
- **Restore**: `bash tools/restore.sh <backup-dir>` — files first, database
  second, so the database never names bytes the store lacks. `--check` reports
  drift without restoring. The restore drill runs on every `make api-test`.
- **Garbage collection**: `bash tools/gc-jobs.sh` (dry run) / `--apply` deletes
  `/jobs` output of jobs done for more than 7 days.
- **Rate limits**: nginx limits PUT to 20/s per address (burst 100, 429 over).
- The file store is write-once; nginx returns 409 on a second PUT. `make
  db-reset` empties the tables but not the store — the tools tolerate the 409s.
- Progress: `curl localhost:3000/progress`, or in SQL
  `SELECT state, count(*) FROM atom GROUP BY 1`.

## 8. Not done, or unrun

- WP3.1's acceptance (a pilot z16 tile trained in < 8 min, PSNR ≥ 24) needs a
  real GPU; the gate trains a small tile over SwiftShader and asserts only that
  training helped.
- WP5.4 needs a headset (`docs/xr.md`).
- Switzerland's rasters and OSM extract need a networked box and ~35 h
  (`docs/seed-ch.md`); the areas and tile rows are seeded by `tools/seed-ch.sh`.
- WP0.11's QGIS round trip and `gis/splatworld.qgz` need GeoServer and QGIS.
- A `suspect` tile cannot be recompiled at the same version: an atom belongs
  to one job (`PROGRESS.md` deviation 55).
- `assemble` fetches `/geo` tiles by path, not by hash (Invariant 2 is not
  pinned for terrain and imagery); a `/geo` path is therefore write-once.
