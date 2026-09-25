# Running the gates

`make player-run` is the gate a story waits for; `make gate` = `db-test` +
`api-test` + `client-test` + `lint` stays underneath it. A story is done only
when both are green.

## With the compose stack

```
cp .env.example .env      # set JWT_SECRET to something >= 32 chars
npm install               # eslint and @playwright/test — dev tooling only
make vendor               # PlayCanvas, Draco, OpenLayers, three, litegraph… for offline tests
make up                   # postgres, postgrest, nginx, geoserver
make gate
```

`api-test` and `files-test` talk to `$API_URL` (default `http://localhost:3000`)
and `$FILES_URL` (default `http://localhost:8081`).

## Without Docker

The gates do not require the compose stack, only the processes it runs. If
nothing is listening, `tools/api-test.sh`, `tools/files-test.sh` and
`tools/test-tiles.sh` start a local `postgrest` and `nginx` themselves, so on a
box with:

- PostgreSQL 16 + PostGIS 3.4 + pgcrypto + pgTAP, and `pg_prove`
- a `postgrest` binary on `PATH`
- `nginx` built `--with-http_dav_module` (Debian/Ubuntu `nginx-extras`), or the
  `splatworld` server (`python -m pip install -e ./server`, `docs/server.md`),
  which the browser tests use in its place when there is no nginx
- `gdal-bin`, which the `tools/make-seed-*.sh` scripts shell out to
- `sqlfluff`
- `cwebp` (Debian/Ubuntu `webp`) — node has no WebP encoder and the test
  tiles are WebP inside (`tools/sogwrite.mjs`)
- node 22 for the tests, plus `npm install` and `make vendor` once

`make gate` runs end to end against a local cluster. Point the `PG*` variables
at it (defaults: `localhost:5432`, user `postgres`, database `splatworld`).

## What each gate covers

| gate | contents |
|---|---|
| `player-run` | the stories of `docs/SPEC.md` §3, one spec each in `client/test/run/`, in order, through the page, from an empty database (`PLAYER-RUN.md`) |
| `db-test` | resets the database, applies every migration, then the pgTAP files in `db/test/*.sql` and the scripts in `db/test/*.sh` (concurrency torture, buying, player roles, two tabs asking for the same tile) |
| `api-test` | `tools/api-test.sh` (PostgREST: login, RLS denials, RPCs), `tools/files-test.sh` (the file store's contract, nginx or `server/`), `tools/ops-test.sh` (backup, restore drill, `gc-jobs`), then `server/test_*.py` |
| `client-test` | the node unit tests in `client/test/*.test.js`, `tools/test-tiles.sh` when a database is reachable, then the headless-chromium specs in `client/test/e2e/` |
| `lint` | sqlfluff over `db/` and `tools/`; eslint over the repository (`eslint.config.js`) |

`make flow-test` runs only the flow editor's two specs
(`flow-modules.spec.js`, `flow-validate.spec.js`); the second needs `ELX_URL`
pointing at a process server and skips, saying so, without one.

`PILOT_BLOCK=1 npx playwright test client/test/e2e/pilot-block.spec.js` compiles
a whole z12 block and redraws `docs/pilot.png`. It is not part of the gate.

## The player-run

`make player-run` (`client/test/run/playwright.config.js`) starts its own
world: an empty database, the `splatworld` server on `RUN_PORT` (8081) with
PostgREST on `RUN_API_PORT` (3000), and a GeoServer publishing
`infra/seed/dem-visp.tif` — `RUN_GEOSERVER_URL` if you point it at yours, else
the compose container on 8083, else `tools/geoserver-fixture.py`
(`RUN_GEOSERVER=fixture` forces the fixture). Missing seed files are fetched by
the `tools/make-seed-*.sh` scripts (`infra/seed/README.md`). It stops at the
first failing story. `RUN_ARGS` passes extra arguments to playwright.

## Browser tests

They run in headless chromium over ANGLE + SwiftShader — no GPU needed; WebGL2
is enough for the viewer. The specs that train ask for WebGPU themselves
(`client/test/e2e/worker.js`), and those that need a real adapter skip on a
software one. They skip, rather than fail, when `client/vendor/playcanvas/` is
missing (`make vendor`), when no database is reachable, or when neither nginx
nor the `splatworld` server will start.

The specs that compile tiles (`assemble`, `frame`, `pilot`, …) write their own
ground: `seedGround()` in `client/test/e2e/serve.js` puts a synthetic
`/geo/dem` tile in the store and `seedWorld()` draws an area with a forest and
a building over it. `assemble.spec.js` also wants OSM features in the pilot
region and skips without them.

`playwright.config.js` points `executablePath` at `/opt/pw-browsers/chromium`
when that exists, for boxes that ship a browser playwright did not install.
The read-only tests have no HTTP server: `client/test/e2e/serve.js` answers the
page's requests from disk and the database. The tests that write (worker loop,
atoms, pilot) need a secure context and a real PUT path, so
`client/test/e2e/services.js` starts a local postgrest and nginx — or the
`splatworld` server where there is no nginx — and a static server; only the
engine CDN is intercepted.
