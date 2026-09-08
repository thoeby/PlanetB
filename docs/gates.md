# Running the gates

`make gate` = `db-test` + `api-test` + `client-test` + `lint`. A task is done
only when it is green.

## With the compose stack (normal)

```
cp .env.example .env      # set JWT_SECRET to something >= 32 chars
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

`make gate` runs end to end against a local cluster. Point the `PG*` variables
at it (defaults: `localhost:5432`, user `postgres`, database `splatworld`).

GeoServer has no automated gate; its checklist is in `gis/README.md`.

## What the gate covers today

| gate | contents |
|---|---|
| `db-test` | 202 pgTAP assertions across schema, auth, RLS, tiles, jobs and publish, then `db/test/0006_concurrency.sh` (32 workers, 4 editors, 2 stale publishers, ~2 min) |
| `api-test` | 17 PostgREST assertions + 11 file-store assertions |
| `client-test` | nothing yet — WP1 |
| `lint` | sqlfluff over `db/` and `tools/`; eslint once there is client JS |
