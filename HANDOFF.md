# HANDOFF.md — for the next instance

Read `CLAUDE.md`, then `ARCHITECTURE.md`, then `PROGRESS.md`. Then start the
first unchecked task in `TASKS.md` — currently **WP3.1**. One task, one commit,
`make gate` green before you commit.

## 1. Get a working environment first

`make gate` needs a live Postgres, a PostgREST and an nginx. If the sandbox has
no Docker daemon (check with `docker info`), do not fight compose — install the
four pieces directly. This takes about three minutes:

```sh
apt-get update -qq
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras webp \
    gdal-bin osm2pgsql
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""

curl -sSL -o /tmp/pgrst.tar.xz \
  https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
tar xf /tmp/pgrst.tar.xz -C /usr/local/bin

pip3 install --break-system-packages sqlfluff

cp .env.example .env
npm install            # eslint and @playwright/test, dev tooling only
make vendor            # the PlayCanvas build the browser tests route to
set -a; . ./.env; set +a
make gate
```

`gdal-bin` and `osm2pgsql` are what `tools/seed-*.sh` shell out to; without them
the seeds cannot cut a tile and `tools/seed-test.sh` says so rather than failing.
`webp` gives you `cwebp`/`dwebp`. `tools/sogwrite.mjs` shells out to them
because node has no WebP codec, and without them WP1.2's test tiles cannot be
built. **Export `.env` into your shell** (`set -a; . ./.env; set +a`) before
running anything under `tools/` directly: the Makefile exports `PG*` for its own
targets, but the tools read them from the environment.

`nginx-extras` is the Ubuntu package built `--with-http_dav_module`; plain
`nginx-light` will not serve PUT. `tools/api-test.sh`, `tools/files-test.sh` and
`tools/test-tiles.sh` start their own PostgREST and nginx when nothing is
listening on `$API_URL` / `$FILES_URL`, so no manual service wrangling is
needed. `docs/gates.md` has the same information for a human.

**No CDN is reachable from the sandbox.** `code.playcanvas.com`, jsdelivr and
unpkg are all refused by the egress proxy; `registry.npmjs.org` works. That is
why `make vendor` exists: `tools/vendor.sh` tries the CDN and falls back to
`npm pack playcanvas@2.22.0`, dropping the engine in the gitignored
`client/vendor/playcanvas/`, and `client/test/e2e/serve.js` routes the CDN URL
in `play.html` there. Without it the browser tests skip rather than fail. The
URL in `play.html` has never been fetched — check it on a networked box.

**Browsers.** `@playwright/test` is pinned in `package.json`, and
`playwright.config.js` points `executablePath` at `/opt/pw-browsers/chromium`
when that exists, because the preinstalled build does not match the version
playwright would download. WebGL2 works there over ANGLE + SwiftShader;
`navigator.gpu` has no adapter, so the WebGPU path is untested — WP3 will need a
real GPU.

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

**claim_atom picks globally**
- It orders by `job.bounty DESC, atom.id` across *every* open job, and
  `expire_claims()` runs inside it, so a fresh run can be handed an atom an
  earlier `api-test` abandoned — including one that was still `claimed` when the
  run started. Both `tools/make-test-tiles.mjs` and
  `client/test/e2e/publish.js` deal with this by setting aside everything
  claimable that is not theirs and putting it back afterwards. Anything new that
  drives the worker loop needs to do the same.

**Deadlocks in the torture test**
- A trapped exception is never logged, so `err_log` says only `40P01 deadlock
  detected` and nothing about which statement. `log_lock_waits = on` with
  `deadlock_timeout = '200ms'` is how to see the waiting pairs.
- The one that was there is fixed (`db/0010_lockorder.sql`): everything now
  takes `tile` row locks coarse before fine. If a new path locks more than one
  tile, keep to that order. Reversing it — editors going fine to coarse — costs
  the z6 serialisation and produced 110 deadlocks in a single run.
- The failure rate was about one run in five, so *one* clean run proves
  nothing. Twenty is the bar used here.

**The file store outlives the database**
- A `make db-reset` empties `artifact` but leaves the bytes on disk, and nginx
  refuses to write a path twice. A second run therefore gets a 409 on a path
  that looks new to the database. `make-test-tiles` accepts a 409 whose bytes
  hash to what it was uploading; `test-tiles.sh` drops `/jobs` directories no
  atom owns any more.

**A SQL function's parameter that shares a name with a column**
- In a SQL-language function a bare name that matches a column of a table in
  scope resolves to the column. `child_sogs(z, x, y)` compared `t.z = z + 2`
  against a `tile t` and meant `t.z = t.z + 2`: false for every row, and every
  merge atom in the system named sixteen empty children (`db/0014_childsogs.sql`).
  It cost WP0.6 the same way (`db/0009_atomid.sql`). Qualify every parameter.

**A canvas premultiplies**
- `putImageData` then `convertToBlob` loses the colour under a low alpha — 91
  counts of error at alpha 0, none at alpha 255. `sog-v1` keeps every plane's
  alpha byte high because of it, and reads planes back through WebGL, which can
  be told not to premultiply (`client/lib/sogenc.js`).

**A Web Worker may only transfer a buffer once**
- Two files that are views into one buffer — a tar's entries are — cannot both
  be transferred. `client/js/atomworker.js` copies anything that is not a whole
  buffer.

**Browser tests that write need a secure context and real services**
- WebCrypto and the Cache API are absent otherwise, and route interception
  cannot answer a PUT. `client/test/e2e/services.js` starts postgrest, nginx and
  a static server on localhost; only the engine CDN is intercepted. nginx's
  temp directories have to be reachable by its worker user, which is not the
  user that started it.

**Content addressing bites in test fixtures**
- An artifact is registered once and the store refuses to write a path twice.
  Two tiles that generate identical bytes therefore fail on the second upload,
  which looks like a permissions bug and is not. WP1.2 hit this when the
  synthetic heightmap depended only on the zoom.

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
  (`0005_jobs.sql` → `0005_state.sql`). The highest applied is `0011_tilefiles`,
  so WP3.3's spot-check migration wants a number **above** that — `0012_spot.sql`
  — not the `0009_spot.sql` an earlier note reserved.
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

## 4. Starting WP3.1

WP3 is training and perceptual verification. Everything around it exists: the
worker loop claims, runs, uploads, submits and publishes; `assemble` writes the
`init.ply` a trainer starts from; `frame` renders the views it learns from.

What you inherit, and where the seams are:

1. **`train` is an `atoms/train.js` and nothing else from the runtime.** Its
   inputs are already resolved for it (`client/js/inputs.js`): the assemble tar
   and the frame tars, as bytes. Its output is a ply; `sog` takes it from there.
2. **`client/lib/render.js` has `psnr()`** and the renderer that drew the
   reference frames, so `verify` compares like with like.
3. **`recheck_atom()`** (`db/0015_structural.sql`) puts a settled deterministic
   atom back in the pool with its answer still on it. That is the lever WP3.3's
   owner spot-check pulls.
4. **A z16 or z18 job already builds the whole DAG** — assemble, six or three
   frame atoms, train, sog, three verify — and `sog` at z >= 16 returns
   `submitted`, not `verified`, so the tile waits for its perceptual checks.
5. **There is no GPU here.** `navigator.gpu` has no adapter in this container,
   so `train`'s WebGPU path cannot be exercised. Get a machine with one.
6. **Splat.js is not vendored yet.** `tools/vendor.sh` is where it goes, next to
   the pinned engine, and `make vendor` is what fetches it.

## 5. Client conventions

- Plain ES modules, relative imports, no bundler. Everything under `client/`
  must stay servable as static files.
- PlayCanvas is a CDN global (`window.pc`), passed into `TileStreamer` rather
  than imported, so `client/js/tiles.js` stays loadable under node — that is
  what lets the traversal be unit-tested without a GPU.
- Policy is separated from rendering on purpose: `selectTiles` is a pure
  function of (tile rows, camera, what is loaded). Keep new decisions on that
  side of the line and they stay testable.
- eslint enforces `CLAUDE.md`'s limits (60 lines a function, 400 a file) and
  runs over `client/` and `tools/`. `eslint.config.js` imports nothing.
- `node --test client/test/*.test.js` — the glob matters, node 22 resolves a
  bare directory as a module path.

## 6. Before you commit

```
make gate        # ~4m30s; the concurrency test and the 30 s hot-swap poll are
                 # most of it. `make vendor` once first, or the browser tests
                 # skip.
```

Commit message `WPx.y: <task title>`. If you deviate from `TASKS.md`, say so in
the commit body and add a row to `PROGRESS.md` — every deviation so far is
recorded there, and that record is the reason this handoff is short.

`CLAUDE.md` says to ask before changing a table that already has a migration,
changing an RPC signature, or adding a dependency. Several of those came up in
WP0 and WP1 and are documented as numbered deviations in `PROGRESS.md`; treat
the list as binding. The dependencies added so far are dev tooling only —
eslint and `@playwright/test` — and the client itself still has none.
