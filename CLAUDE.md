# CLAUDE.md — splatworld

Read `ARCHITECTURE.md` first, then work through **`PLAYER-RUN.md`** in order:
the stories of `docs/SPEC.md` §3, each proven by a script that behaves like a
player. One story = one commit. Do not start a story whose predecessor is not
green on the same run. `TASKS.md` and `TASKS-usable.md` are history.

State of the work so far: `PROGRESS.md`. Environment setup and the traps already paid for: `HANDOFF.md`.

What the player meets, and what it looks like: `docs/SPEC.md` (the product specification) and `docs/design/` (eleven artboards, with `docs/design/README.md` mapping each part of the design to the file that holds it). Read them before changing anything anyone sees.

## What this is

A persistent digital world on real geography, compiled into Gaussian-splat LOD tiles (z6…z18). Server = Postgres/PostGIS + PostgREST + GeoServer + nginx. **Server executes no compute.** Every atom (assemble, frame, train, merge, sog, verify) runs in a player's browser tab. Publishing is a conditional pointer update in Postgres.

## Invariants (never violate; if a task seems to require it, stop and ask)

1. Every artifact is immutable and content-addressed (`sha256`). Files are never overwritten.
2. Every atom has immutable inputs (artifact hashes + params + seed) and an `algo_version`.
3. `publish_tile` is a compare-and-swap on `tile.expected_version`. A stale worker can never publish.
4. Triggers only mark `tile.dirty`. Job/atom creation happens only through idempotent `ensure_job()`.
5. Money, rights, editions: one SQL transaction each, `ref`-idempotent, ledger append-only.
6. All client writes are authorised by row-level security, never by client code.
7. Merged tiles (z ≤ 14) are deterministically reproducible → verified by hash equality.
8. Trained tiles (z16/z18) are verified probabilistically (structural → 3 independent perceptual checks). Say so in code comments; do not call it "proof".
9. Server never decides or performs rendering. No server-side worker, no cron that computes. GeoServer publishes the operator's elevation over WCS and nothing else; QGIS edits the database as the player, under RLS.
10. No new server components. Allowed processes: postgres, postgrest, geoserver, nginx — or, in place of nginx, the `splatworld` server in `server/` (Python stdlib + psycopg), which serves the file store and the static client and supervises PostgREST. It exists because nginx cannot be had with `--with-http_dav_module` on Windows without compiling it, and it is held to the same contract by `tools/files-test.sh`, nginx's own gate, which it passes unmodified. It computes nothing about the world. (Optional later: a dependency-free `ws` presence relay — not in v1.)

## Stack rules

- SQL: PostgreSQL 16, PostGIS 3.4. Schema in `db/` as numbered migrations (`db/0001_*.sql`). Every function has a pgTAP test in `db/test/`.
- API: PostgREST 12, config in `infra/postgrest.conf`. JWT HS256. Roles: `anon`, `player`, `admin`.
- Files: nginx with `ngx_http_dav_module`, `auth_request` to PostgREST `rpc/can_write`. Config in `infra/nginx.conf`. `server/` is the same contract in Python, for machines without such an nginx; the two are kept interchangeable by `tools/files-test.sh`.
- Client: plain ES modules, no bundler, no framework. PlayCanvas engine 2.x pinned from CDN. Splat.js vendored under `client/vendor/` (MIT). Everything under `client/` must be servable as static files.
- Tests: `db/test` (pgTAP via `pg_prove`), `client/test` (node + playwright for headless Chromium with WebGPU; browser tests may be skipped in CI if no GPU, but must run locally).
- No TypeScript build, no npm dependencies in the client beyond vendored files. Node is used only for tests and tooling.

## Working rules

- Read the task, restate the acceptance criteria in one line, implement, run the gate, commit with message `WPx.y: <task title>`.
- If a gate fails, fix within the same task; do not move on.
- Do not add features not in the task. Do not "improve" adjacent code.
- Ask before: changing a table that already has a migration, changing an RPC signature, adding a dependency.
- Prefer deleting over abstracting. No repositories/services/managers layers.
- Keep functions < 60 lines, files < 400 lines; split otherwise.
- Write comments only where an invariant is being enforced; reference the invariant number.

## Gates (run before every commit)

```
make player-run     # the stories, through the page, from an empty database
make db-test        # resets DB, applies migrations, runs pgTAP
make api-test       # PostgREST smoke: login, RLS denials, RPCs
make client-test    # node unit tests + playwright headless (skips GPU tests if unavailable)
make lint           # sqlfluff + eslint (flat config, no build)
```

`make gate` runs the last four. A story is done when `make player-run` is
green through it and `make gate` is green under it.

## Layout

```
splatworld/
  CLAUDE.md  ARCHITECTURE.md  TASKS.md  Makefile
  db/            0001_schema.sql 0002_rls.sql 0003_functions.sql … test/*.sql
  infra/         compose.yml postgrest.conf nginx.conf geoserver/  seed/
  client/        play.html edit.html catalog.html
                 js/{api,auth,tiles,origin,player,build,work,catalog}.js
                 atoms/{assemble,frame,train,merge,sog,verify}.js
                 lib/{tilemath,canon,hash,ply,sogenc}.js   vendor/
                 test/
  tools/         seed-dem.sh seed-ortho.sh seed-osm.sh (developer tooling, runs on the dev box, not the server)
```
