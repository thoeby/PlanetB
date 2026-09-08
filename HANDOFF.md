# HANDOFF.md — for the next instance

Read `CLAUDE.md`, then `ARCHITECTURE.md`, then `PROGRESS.md`. Then start the
first unchecked task in `TASKS.md` — currently **WP1.1**. One task, one commit,
`make gate` green before you commit.

## 1. Get a working environment first

`make gate` needs a live Postgres, a PostgREST and an nginx. If the sandbox has
no Docker daemon (check with `docker info`), do not fight compose — install the
four pieces directly. This takes about three minutes:

```sh
apt-get update -qq
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""

curl -sSL -o /tmp/pgrst.tar.xz \
  https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
tar xf /tmp/pgrst.tar.xz -C /usr/local/bin

pip3 install --break-system-packages sqlfluff

cp .env.example .env
make gate
```

`nginx-extras` is the Ubuntu package built `--with-http_dav_module`; plain
`nginx-light` will not serve PUT. `tools/api-test.sh` and `tools/files-test.sh`
start their own PostgREST and nginx when nothing is listening on `$API_URL` /
`$FILES_URL`, so no manual service wrangling is needed. `docs/gates.md` has the
same information for a human.

If Docker *is* available, `make up` + `make gate` should work — but nobody has
run `infra/compose.yml` yet, so expect to debug it and commit the fix.

## 2. Traps already paid for

Things that cost time once. Do not rediscover them.

**pgTAP**
- `SELECT plan(n)` must match the assertion count exactly. Write the test, run
  it, then set `n` from what it reports.
- A temp fixture table read after `SET ROLE player` needs
  `GRANT SELECT ON <tbl> TO player`.
- RLS denials come in two shapes and the test must assert the right one:
  no grant at all raises `42501`; a grant whose policy does not match filters
  `UPDATE`/`DELETE` to **zero rows, silently**. `db/test/0003_rls.sql` has a
  `touched(sql)` helper for the second case.
- `PERFORM` is plpgsql only. In a test file use
  `CREATE TEMP TABLE x AS SELECT ...` to run something without printing rows
  that would confuse the TAP parser.

**Composite-returning functions**
- `SELECT * FROM claim_atom('{}'::jsonb)` calls it **once**.
  `SELECT (claim_atom('{}'::jsonb)).*` calls it **once per column** — sixteen
  claims instead of one. This will not look like a bug; it will look like the
  claim logic is broken.

**plpgsql**
- A parameter named like a column (`z`, `x`, `y`, `sha256`, `kind`, `bytes`)
  breaks `ON CONFLICT (...)` and bare column references with "column reference
  is ambiguous". Fixes used here: qualify as `function_name.param`, add
  `#variable_conflict use_column` plus local aliases, or lift the statement
  into a small helper with distinct parameter names (`dirty_parent` in
  `db/0006_publish.sql`).
- A `COMMIT` inside a `BEGIN … EXCEPTION` block raises `2D000`
  ("cannot commit while a subtransaction is active"). Put the commit after the
  block ends. `db/test/0006_concurrency.sh` shows the shape.

**Test isolation**
- `tools/api-test.sh` and `tools/files-test.sh` run against a database that
  already has state. Both derive a per-run lon/lat offset from `$(date +%s%N)`
  and open the job for the tile their *own* feature dirtied. Any new script
  must do the same or the second run will fail on someone else's tile.
- `claim_atom` orders by `job.bounty DESC, atom.id`. A test that assumes "the
  lowest id is claimed first" breaks the moment a bounty exists anywhere.

**sqlfluff**
- It has no plpgsql grammar; function bodies come back unparsable, so
  `.sqlfluff` sets `ignore = parsing`. That means the bodies are *not* linted
  — pgTAP is the only thing checking them.
- `AL03`, `CP01`, `CP02` are excluded because PostGIS type modifiers and the
  `PUBLIC` / `VALUE` keywords are misparsed as identifiers.

## 3. Conventions this code already commits to

- **Migrations are numbered and never edited once applied.** Add a new file;
  `CREATE OR REPLACE FUNCTION` to change behaviour. Files sort lexically, so a
  second file for the same number needs a suffix that sorts after the first
  (`0005_jobs.sql` → `0005_state.sql`). `0009_spot.sql` is reserved for WP3.3.
- **Every client write is authorised by RLS**, never by a grant on a base
  table. Tables that no policy covers have no write grant at all and move only
  under `SECURITY DEFINER` functions. The one exception is the `geoserver`
  login role (`BYPASSRLS`), which is the admin path and is not reachable from a
  browser.
- **New API surface goes in `db/0007_api.sql`'s pattern**: a
  `security_invoker` view or a thin `api.*` wrapper over the `public` function,
  plus an explicit `GRANT EXECUTE`. The view must never add authority.
- **Comments mark invariants, nothing else.** Write `-- Invariant 3: …` where
  one is being enforced; skip commentary everywhere else.
- **Structural checks are rows in `structural_rule`, not code.** WP2.7 adds
  more; the evaluator in `run_structural` already takes `$1` = atom row,
  `$2` = result jsonb, `$3` = output bytes.

## 4. Starting WP1.1

Deliverable: `client/play.html`, `client/js/{api,auth}.js`,
`client/lib/tilemath.js`, `client/test/tilemath.test.js`.
Acceptance: 50 fixture rows exported from SQL `tiles_for_geom` match
bit-for-bit.

Concretely:

1. The SQL to mirror is `db/0004_tiles.sql` — `tile_x`, `tile_y`, `tile_bbox`,
   `tiles_for_geom`, plus ancestors/children (`z-2, x/4, y/4` and the 16
   grandchildren, as `child_sogs` in `db/0005_jobs.sql` does it). Note the
   zoom ladder is **even zooms only**, 6…18.
2. Generate the fixtures, do not type them: a small script that runs
   `tiles_for_geom` over 50 geometries and writes JSON into `client/test/`.
   Commit the generator alongside the fixture so it can be regenerated.
3. `make client-test` currently reports "no tests yet"; it runs
   `node --test client/test/` as soon as a `*.test.js` exists. Playwright is
   still skipped until `playwright.config.js` and `node_modules/@playwright`
   exist — that is WP1.3's problem, not WP1.1's.
4. Once client JS exists, `make lint` stops skipping eslint: add a flat
   `eslint.config.js` and keep it dependency-free per `CLAUDE.md`.
5. `client/` must stay servable as static files. No bundler, no npm packages in
   the client, PlayCanvas pinned from a CDN, Splat.js vendored under
   `client/vendor/`.

## 5. Before you commit

```
make gate        # ~2m30s; the concurrency test is most of it
```

Commit message `WPx.y: <task title>`. If you deviate from `TASKS.md`, say so in
the commit body and add a row to `PROGRESS.md` — every deviation so far is
recorded there, and that record is the reason this handoff is short.

`CLAUDE.md` says to ask before changing a table that already has a migration,
changing an RPC signature, or adding a dependency. Three of those came up in
WP0 and are documented in `PROGRESS.md`; treat the list as binding.
