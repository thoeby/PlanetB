# Running the gates

`make gate` = `db-test` + `api-test` + `client-test` + `lint`. A task is done
only when it is green.

## With the compose stack (normal)

```
cp .env.example .env      # set JWT_SECRET to something >= 32 chars
npm install               # eslint and @playwright/test — dev tooling only
make vendor               # the PlayCanvas build the browser tests route to
make up                   # postgres, postgrest, nginx, geoserver
make gate
```

`api-test` and `files-test` talk to `$API_URL` (default `http://localhost:3000`)
and `$FILES_URL` (default `http://localhost:8080`).

## Without Docker

The gates do not require the compose stack, only the four things it runs. If
nothing is listening, `tools/api-test.sh` and `tools/files-test.sh` start a
local `postgrest` and `nginx` themselves, so on a box with:

- PostgreSQL 16 + PostGIS 3.4 + pgcrypto + pgTAP, and `pg_prove`
- a `postgrest` binary on `PATH`
- `nginx` built `--with-http_dav_module` (Debian/Ubuntu `nginx-extras`)
- `gdal-bin` and `osm2pgsql`, which the seeding tools shell out to
- `sqlfluff`
- `cwebp` and `dwebp` (Debian/Ubuntu `webp`) — node has no WebP codec and the
  test tiles are WebP inside
- node 22 for the tests, plus `npm install` and `make vendor` once

`make gate` runs end to end against a local cluster. Point the `PG*` variables
at it (defaults: `localhost:5432`, user `postgres`, database `splatworld`).

GeoServer has no automated gate; its checklist is in `gis/README.md`.

## What the gate covers today

| gate | contents |
|---|---|
| `db-test` | 450 pgTAP assertions over 22 files — schema, auth, RLS, tiles, jobs, publish, atom identity, the tile file store, the work panel's query, `tile_world`, `child_sogs`, the structural checks, perceptual verification and trust, and the catalog's SAN derivation — then `db/test/0006_concurrency.sh` (32 workers, 4 editors, 2 stale publishers, ~2 min) |
| `api-test` | 17 PostgREST assertions, 15 file-store assertions (including WP4.1's PUT-and-register round trip for a canonical GLB), 15 seeding assertions (`tools/seed-test.sh`, which also cuts one z14 dem and ortho tile straight off AWS and skips if it cannot reach them) |
| `client-test` | 95 node assertions (tilemath against SQL fixtures, the traversal, the floating origin, the player, the worker loop, assemble, the camera sets, the merge grid, the sog quantisation, the trainer's gradients, the spot checker, canon-v1 over five exporter fixtures and the Draco round trip), `tools/test-tiles.sh` (22 assertions), then 22 headless-chromium tests |
| `lint` | sqlfluff over `db/` and `tools/`; eslint over `client/` and `tools/` |

`make gate` takes about 10 minutes. The slow parts are the concurrency torture
test, the hot-swap test (which waits out the viewer's real 30 s poll),
`client/test/e2e/pilot.spec.js`, which compiles a z14 tile of the pilot and its
four ancestors from real data, and `client/test/e2e/train.spec.js`.

`PILOT_BLOCK=1 npx playwright test client/test/e2e/pilot-block.spec.js` compiles
a whole z12 block and redraws `docs/pilot.png`. It is not part of the gate:
sixteen baseline tiles are minutes of real work.

## Browser tests

They run in headless chromium over ANGLE + SwiftShader — no GPU needed, and
WebGL2 is enough for the gsplat pipeline. They skip, rather than fail, when
`client/vendor/playcanvas/` is missing (`make vendor`), when no database is
reachable, or when the file store has no published tiles. The assemble, frame
and pilot tests also need the pilot's DEM in the store (`bash tools/seed-dem.sh`
and `seed-ortho.sh`, about 400 MB from AWS the first time); the gate's own
`seed-test` cuts a single z14 tile, which is not enough for them.

`client/test/e2e/{assemble,frame,pilot}.spec.js` compile real tiles and need the
pilot's DEM and ortho in the store — `bash tools/seed-dem.sh && bash
tools/seed-ortho.sh`, once per box. They skip only if `geo/dem` is missing
entirely; a partial seed fails instead.

`playwright.config.js` points `executablePath` at `/opt/pw-browsers/chromium`
when that exists, for boxes that ship a browser playwright did not install.
The read-only tests have no HTTP server: `client/test/e2e/serve.js` answers the
page's requests from disk and the database. The tests that write (worker loop,
atoms, pilot) need a secure context and a real PUT path, so
`client/test/e2e/services.js` starts a local postgrest, nginx and static server
for them; only the engine CDN is intercepted.
