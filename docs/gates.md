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
| `db-test` | 217 pgTAP assertions across schema, auth, RLS, tiles, jobs, publish, atom identity and the tile file store, then `db/test/0006_concurrency.sh` (32 workers, 4 editors, 2 stale publishers, ~2 min) |
| `api-test` | 17 PostgREST assertions + 11 file-store assertions |
| `client-test` | 38 node assertions (tilemath against SQL fixtures, the tile traversal, the floating origin, the player), `tools/test-tiles.sh` (22 assertions: builds and publishes the 7 test tiles), then 6 headless-chromium tests |
| `lint` | sqlfluff over `db/` and `tools/`; eslint over `client/` and `tools/` |

`make gate` takes about 4m30. The two slow parts are the concurrency torture
test and the hot-swap test, which waits out the viewer's real 30 s poll.

## Browser tests

They run in headless chromium over ANGLE + SwiftShader — no GPU needed, and
WebGL2 is enough for the gsplat pipeline. They skip, rather than fail, when
`client/vendor/playcanvas/` is missing (`make vendor`), when no database is
reachable, or when the file store has no published tiles.

`playwright.config.js` points `executablePath` at `/opt/pw-browsers/chromium`
when that exists, for boxes that ship a browser playwright did not install.
There is no HTTP server: `client/test/e2e/serve.js` answers the page's requests
from disk and the database, because `client/` is static files and the file store
is a directory of immutable blobs.
