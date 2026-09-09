# splatworld — install, deploy and use

What exists today: WP0–WP2 (`PROGRESS.md`). A world of real terrain, imagery
and OpenStreetMap features is compiled into Gaussian-splat tiles z6…z14 by
browser tabs and streamed back into a first-person viewer. Training (z16/z18),
the catalog, building, money UI, the web GIS editor and XR are WP3–WP5 and are
not implemented yet.

## 1. What runs where

| process | role | port (compose) |
|---|---|---|
| PostgreSQL 16 + PostGIS | the world, jobs, atoms, ledger, auth | 5432 |
| PostgREST 12 | the only API (`/api` in docs, `http://host:3000` in practice) | 3000 |
| nginx | immutable file store `/assets /tiles /jobs /geo`, static client under `/app/` | 8080 |
| GeoServer 2.26 | admin/visualisation only, WFS-T for QGIS | 8081 |

The server executes no compute. Every atom (assemble, sample, merge, sog, …)
runs in a player's browser tab (Invariant 9).

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

`infra/compose.yml` is checked with `docker compose config` but has not been
started on a box with a Docker daemon yet; the file store and every gate have
been run against the four processes installed directly (2b). If `make up`
needs a fix, commit it.

### 2b. Without Docker (dev box, CI)

Ubuntu 24.04:

```sh
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras webp gdal-bin osm2pgsql
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""
curl -sSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz \
  | tar xJ -C /usr/local/bin
pip3 install sqlfluff
cp .env.example .env
npm install                  # eslint + playwright, tooling only
make vendor                  # PlayCanvas copy for the browser tests
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

The client finds its endpoints in two `<meta>` tags at the top of
`client/play.html` (`splatworld:api`, `splatworld:files`). Edit them for a
deployment that is not on `localhost`. nginx answers CORS for the store, so the
client may be served from another origin.

Compose binds Postgres, PostgREST and GeoServer to `127.0.0.1`; only the file
store (8080, which also serves the client) listens on all interfaces. For a
public deployment put a TLS proxy in front of 8080 and 3000, and edit the
`<meta>` endpoints accordingly. The `geoserver` database role has `BYPASSRLS`.
It is the operator's door; never expose port 8081 or that role to the internet.

The user `seed@splatworld.local` that the seed tools create is an `admin`
whose password hash is locked; it cannot log in. Create your own admin with
`register()` and `UPDATE auth.user SET role = 'admin'` over psql.

## 4. Seed a region

Dev-box tooling, run once per region. The pilot is the z10 tile 10/534/358
(Aarau, Switzerland). Details and knobs: `infra/seed/README.md`.

```sh
set -a; . ./.env; set +a
bash tools/seed-dem.sh                                   # /geo/dem  (Copernicus GLO-30 or swissALTI3D)
bash tools/seed-ortho.sh                                 # /geo/ortho (Sentinel-2 or swissimage)
OSM_FILE=switzerland-latest.osm.pbf bash tools/seed-osm.sh   # features + one area per z12, detail 14
```

Seeding creates the user `seed@splatworld.local`, sixteen areas and the
`feature` rows; the trigger marks every covering tile z6…z14 dirty. That is the
work queue.

## 5. Use

### Play (`/app/play.html`)

- **Sign in / create account** in the top-left panel. Reading the world needs
  no account; working and editing do.
- **Move**: WASD, Space up, Shift down, mouse look after clicking the canvas
  (pointer lock), `F` toggles walk/fly. The ground comes from the finest
  loaded tile's heightmap; colliders block you.
- **Status line**: published tiles, loaded/loading, origin rebases, hot swaps.
  The viewer polls the loaded tiles every 30 s and swaps in new versions.
- The streamer only refines into a tile whose children are all published. A
  z12 block shows z14 detail only once all its z14 tiles exist.

### Work panel (same page)

- Shows the GPU this tab has (WebGPU or WebGL2).
- **My dirty tiles**: tiles you own an area in that need compiling; `render`
  calls `ensure_job` and starts the loop.
- **work in the background**: claim any ready atom, run it in a Web Worker,
  upload to the store, submit, publish. Leave the tab open; it heartbeats
  every 60 s and a claim expires after 5 minutes of silence.
- The last six log lines show claim/upload/submit/publish events.

To compile a region: sign in as the owner of its areas (the seed user, or your
own after inserting an `area`), press `render` on a z14 tile, then on the z12,
z10, z8, z6 above it once their children are published. Ancestors are marked
dirty automatically when a child publishes. Each z14 tile is ~20 s of work in a
tab; `client/test/e2e/pilot-block.spec.js` does a whole z12 block unattended.

### API (PostgREST)

Tables are read through `security_invoker` views; writes go only through RPCs
(`db/0007_api.sql`). Examples:

```sh
curl -X POST localhost:3000/rpc/register -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}'
TOKEN=$(curl -s -X POST localhost:3000/rpc/login -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","pw":"password12"}' | tr -d '"')
curl localhost:3000/tile?dirty=is.true                      # anyone
curl -X POST localhost:3000/rpc/ensure_job -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"z":14,"x":8552,"y":5737}'
```

RPCs: `register login ensure_job claim_atom heartbeat submit_atom publish_tile
set_bounty pay register_artifact my_dirty_tiles recheck_atom can_write`.
Row-level security decides every write; the client has no authority of its own.

### Admin (QGIS)

`bash infra/geoserver/provision.sh` once, then load `gis/splatworld-wfs.xml`
in QGIS and edit `feature_*`, `area`, `instance` over WFS-T. `gis/README.md`
has the checklist. `splatworld:tile` shows compile state (red / orange / green).

## 6. Verify an installation

```sh
make gate         # db-test, api-test, client-test, lint — about 8 minutes
```

`docs/gates.md` lists what each gate covers and when browser tests skip. The
assemble, frame and pilot browser tests need the pilot seeded (section 4) and
skip otherwise. `make db-test` resets the database: do not run it against a
live world.

## 7. Operations notes

- The file store is content-addressed and write-once; nginx returns 409 on a
  second PUT. `make db-reset` empties the tables but not the store — remove
  `$FILES_ROOT` too for a clean slate, or expect 409s the tools already tolerate.
- Backups: `pg_dump` the database and copy `$FILES_ROOT/{assets,tiles,geo}`;
  `/jobs` is intermediate and reproducible. A backup script is WP5.5.
- No cron, no queue, no worker process: if nothing is being compiled, no tab is
  open. Progress is `SELECT count(*) FROM tile WHERE dirty` and
  `SELECT state, count(*) FROM atom GROUP BY 1`.

## 8. Not done (WP3–WP5)

Training on WebGPU (`train-v1`, Splat.js), perceptual `verify`, owner
spot-check and trust; catalog, canonical GLB and build mode; areas/grants UI,
proposals and money UI; Switzerland-wide seed, background rendering
prioritisation, `edit.html`, XR, backup/GC scripts and rate limits. See
`TASKS.md` from WP3.1 and `HANDOFF.md` §4.
