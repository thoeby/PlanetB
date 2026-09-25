# HANDOFF.md — for the next instance

Read `CLAUDE.md`, then `PLAYER-RUN.md`, then `ARCHITECTURE.md` and
`PROGRESS.md`. One story, one commit, `make player-run` green — and `make
gate` under it — before you commit.

**`TASKS.md` is history** (`docs/history/`). Every task in it is done, and finishing them did not
make the thing usable: `PLAYER-RUN.md` is the task list now, and a story counts
only when a script that behaves like a player completes it through the page.
What is still unrun for want of hardware or data this container has not got is
in §6: WP3.1's acceptance on a GPU, WP5.4's on a headset, and the full
Switzerland raster seed.

## 0. The task is `PLAYER-RUN.md`

`make player-run` is the gate that matters now; `make gate` stays underneath
it. It needs, on top of §1's environment:

```sh
pip3 install --break-system-packages --ignore-installed numpy   # see below
pip3 install --break-system-packages pytest -e server/
bash tools/make-seed-dem.sh        # 4 x 4 km of Visp, off AWS open data, once
make player-run
```

**`gdal-bin` brings a Debian numpy that this image's python cannot import.**
`apt-get install gdal-bin` pulls `python3-numpy` built for another python, and
it shadows the wheel rasterio needs: every `import rasterio` then dies in
`numpy.core._multiarray_umath`. `pip3 install --ignore-installed numpy` puts a
working one in front of it. `make api-test` also needs `pytest`, which two
server tests import.

**QGIS is an apt package here, and PyQGIS wants the system python.**
`apt-get install -y qgis python3-qgis qgis-providers` gives QGIS 3.34 from
Ubuntu noble/universe. `import qgis.core` works under `/usr/bin/python3.12`
and not under the `/usr/local/bin/python3` on PATH, which is a different
build; `client/test/run/qgis.js` finds the one that works. Every QGIS run
needs `QT_QPA_PLATFORM=offscreen` — there is no display, and without it Qt
aborts before any of your code runs.

**No container registry is reachable from this sandbox.** `docker.osgeo.org`
and `production.cloudfront.docker.com` are both 403 at the egress proxy, so
the GeoServer container in `infra/compose.yml` cannot be pulled here.
`client/test/run/world.js` therefore falls back to
`tools/geoserver-fixture.py`, which serves `infra/seed/dem-visp.tif` as a WCS
1.0.0 coverage and a WMS hillshade — the two conversations the world has with
a GeoServer. The run prints which one answered. **A story that passed against
the fixture has passed against the fixture only**; the operator's machine runs
the container.

## 1. Get a working environment first

`docs/manual.md` is the install and user manual; this section is the short form.

`make gate` needs a live Postgres, a PostgREST and an nginx. If the sandbox has
no Docker daemon (check with `docker info`), do not fight compose — install the
four pieces directly. This takes about three minutes:

```sh
apt-get update -qq
apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 postgresql-16-pgtap \
    libtap-parser-sourcehandler-pgtap-perl nginx-extras webp \
    gdal-bin osm2pgsql rsync
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""

curl -sSL -o /tmp/pgrst.tar.xz \
  https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
tar xf /tmp/pgrst.tar.xz -C /usr/local/bin

pip3 install --break-system-packages 'sqlfluff==3.4.2'   # pinned: see below

cp .env.example .env
npm install            # eslint and @playwright/test, dev tooling only
make vendor            # the PlayCanvas build the browser tests route to
set -a; . ./.env; set +a
make gate
```

**Nothing needs seeding before `make gate`.** The browser specs write the
ground they need themselves (`seedGround` and `seedWorld` in
`client/test/e2e/serve.js`: a dem-v1 ramp at the address the server's cut would
have written, and a land with a wood and a house on it). The player-run's
ground is `tools/make-seed-dem.sh` (§0). `gdal-bin` is what that script and
`tools/make-seed-osm.sh` / `tools/make-seed-cover.sh` shell out to.

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
playwright would download. WebGL2 works there over ANGLE + SwiftShader.

**WebGPU is available, with two conditions.** `navigator.gpu` is not defined
unless chromium is launched with `--enable-unsafe-webgpu` *and* the page is on a
secure origin — `about:blank` and `http://splatworld.test/` are not, `localhost`
is. With both, Dawn gives a real device over SwiftShader: the trainer's shaders
compile and run, at perhaps a hundredth of the speed of a
GPU. `client/test/e2e/train.spec.js` sets the flag
itself with `test.use({ launchOptions })`; the default config does not, so
every other test still sees the WebGL2-only machine it was written for.

If Docker *is* available, `make up` + `make gate` should work — but nobody has
run `infra/compose.yml` yet, so expect to debug it and commit the fix.

**The design is `docs/design/`, and `docs/design/README.md` says which file
holds which part of it.** Do not restyle the chrome without reading it.

**A stylesheet served with the wrong media type is refused silently.** The page
then renders complete, correct and unstyled, and every browser assertion about
text still passes — which is how `client/hud.css` went unexercised by the whole
e2e suite. `serve.js` and `services.js` have a `.css` type now, and
`client/test/e2e/hud.spec.js` asserts that a rule actually applies rather than
that an element exists.

**`make vendor` fetches the fonts too.** `client/hud.css` @font-face's Rajdhani,
Sora and JetBrains Mono out of `client/vendor/fonts`; `tools/vendor.sh` pulls
them from @fontsource on npm, because fonts.gstatic.com is outside this
container's egress policy. Every rule that names them names a system fallback,
so a checkout that never ran it still reads.

**Two specs still depend on the order the suite runs in.** `make client-test`
is 42 passed, 2 failed here, and both failures are one thing: the browser
suite compiles into the very tiles `tools/test-tiles.sh` published for the
viewer to look at.

- `sog.spec.js` and `merge.spec.js` merge into 8/133/90 and publish, with
  manifests of their own.
- `stream.spec.js` runs later (files run alphabetically) and asserts which
  tiles the streamer picks at each distance — an answer that comes out of
  those manifests. It sees the z6 where it expects the two z8 parents.

Both pass on their own, immediately after `bash tools/test-tiles.sh`. Two
things were tried and are not the answer: snapshotting and restoring the tile
rows around the mutating specs (the bytes the old manifest points at are gone
by then), and running the viewer's specs first as a Playwright project
dependency (a viewer failure then stops the other 34 specs from running at
all). What it wants is for the compiling specs to own a tile the viewer does
not assert on — which means a second published ladder in the fixture, not a
smaller patch.

**`tools/test-tiles.sh` wants a world nobody has seeded yet.** It publishes
three versions of a tile in a row, and reads the version to publish after its
atoms have run; in a world with thousands of features already drawn, something
dirties the tile in between and the publish is refused with "no verified sog of
yours for …". `make db-reset` then `bash tools/test-tiles.sh`, before
`api-test` seeds anything, works. Run out of order it does not, so a bare
`make gate` on a seeded box fails here and the viewer tests then skip for want
of published tiles.

## 2. Traps already paid for

Things that cost time once. Do not rediscover them.

**A panel that redraws is a panel that loses things**
- Every panel in this client rebuilds its nodes on a timer. Three separate
  bugs came out of that and each one looked like something else:
  a field somebody was typing into was replaced, so the text went nowhere and
  the button read an empty note; a status line was replaced between a press and
  its answer, so the answer was never seen; and a button moved under a hand
  reaching for it, which Playwright reports as "element is not stable".
- Two rules, both already applied: a node that holds something (a field, a
  status line) is made once by the panel and moved into each card it draws
  (`client/js/land.js` `keeper()`, `client/js/permissionui.js` `noteField`),
  and a card is rebuilt only when it would say something different
  (`cardSignature` in land.js, `shown` in permission.js). Do the same for any
  new panel.
- The same shape in the world: an answer that arrives after the next question
  was asked must not be discarded by *identity*, only by the question having
  moved on. `whereAmI` in `client/play.html` discards by position, because under
  load every answer arrived after the next question and the line never changed.

**Frames: metres above sea level are not metres in the scene**
- A DEM answers in metres above sea level. Everything in the scene is metres
  from the floating anchor, and the anchor moves under the camera as you
  travel. `Terrain.heightAt` converts; anything else that reads the ground has
  to as well, or a player is twice their own height in the air after they have
  walked far enough to rebase.

**Coarse ground tiles run off the end of a coverage**
- A tile at z10 is twenty-seven kilometres across and an operator's coverage is
  often four. A WCS asked for ground it has not got answers with an exception
  report, not with nodata, so `ground.cut` clips the request to the coverage and
  warps what comes back onto the whole tile. Nodata is sea level
  (`server/splatworld/dem.py`), so the viewer draws no ground past the edge of
  the coverage at all (`NODATA_ELEVATION_M` in `client/lib/geo.js`, read by
  `client/js/floor.js`).
- The extent recorded in `ground` when the coverage was chosen can be wider than
  where the data actually is — a declared bounding box often is — so clipping to
  it is not enough. `describe_coverage` now returns the coverage's own
  `envelope` and `_ask` clips to that, in the native CRS, and answers "nothing
  here" (404) rather than raising when a tile is past it.
- "The service is not answering" and "the service will not give me that tile"
  are different sentences and only the first is a broken world:
  `importer.Unreachable` marks the first, and `_ask` counts whether anything
  answered at all.
- `fetch` used to read the first 400 bytes of an HTTP error body. An OGC
  exception report begins with a screenful of namespace declarations, so cut off
  there it is no longer XML and the one useful sentence in it could not be
  parsed out — every caller printed the namespaces instead.

**A browser that walks away is not an error**
- A tab that navigates, closes, or gives up on a slow tile aborts the
  connection, and the stdlib server printed a full traceback per abandoned
  request (WinError 10053 on Windows). `serve.GONE` and `Server.handle_error`
  make that one line.

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

**An artifact whose atom is gone is registered but unfindable**
- `client/js/inputs.js` finds where an artifact's bytes are by asking which
  atom produced it (`result.path`, else `/jobs/{atom}/…`). A fixture that
  rebuilds a DAG by deleting the job's atoms therefore orphans everything the
  last run uploaded: the store refuses the path (`can_write`: already
  registered), and the worker has nowhere left to ask. The browser fixtures
  give each run a fresh `seed`, which makes fresh bytes and collides with
  nothing (`client/test/e2e/train.spec.js`).

**Content addressing bites in test fixtures**
- An artifact is registered once and the store refuses to write a path twice.
  Two tiles that generate identical bytes therefore fail on the second upload,
  which looks like a permissions bug and is not. WP1.2 hit this when the
  synthetic heightmap depended only on the zoom.

**A worker that saturates the machine stops beating**
- `setInterval` callbacks arrive on the main thread, and a Web Worker rendering
  in software takes every core there is. The first z16 training run here lost
  its claim to `expire_claims` twice while it was still working.
  `WorkLoop.step` now also beats when the atom logs something, so an atom that
  reports progress keeps its claim. Anything long-running should log.

**A verify atom writes no artifact**
- `artifact.kind` has no `verify` and adding one means altering a table with a
  migration behind it. `client/js/work.js` therefore accepts `output: null` with
  an empty `files`, and `submit_atom` forwards the result to
  `submit_verification` server-side. That is also the only place the "three
  distinct workers, none of them the trainer" rule can be enforced.

**claim_atom has trust gates now**
- `train` needs trust >= 0.3 and `verify` >= 0.6 (`db/0019_trust.sql`), and a
  new worker starts at 0.5. A fixture that expects a fresh worker to be handed a
  verify atom will silently be handed nothing instead. `db/test/0017_verify.sql`
  and `client/test/e2e/train.spec.js` both create their verifiers with trust
  0.8 and say why.

**The trainer is brush, and brush's wasm is ours to build**
- `train` hands the dataset to brush (`client/lib/brush.js`), vendored as
  wasm under `client/vendor/brush/` and built by `tools/build-brush.sh`, which
  applies `tools/brush-*.patch` at one pinned brush revision. A change to a
  patch means a rebuild and the rebuilt wasm checked in. The hand-written
  WGSL trainer this replaced (`gsgpu.js`, `gswgsl.js`) is gone.

**Pin the linters.** `sqlfluff` and `eslint` both moved rules under us:
sqlfluff 4.x turns on `AM05` and widens `CP04`, and eslint past 9.15 counts
function lines differently. `make lint` is green with `sqlfluff==3.4.2` and the
`eslint` in `package.json`; install those two and nothing newer, or spend the
afternoon on style.

**sqlfluff**
- It has no plpgsql grammar; function bodies come back unparsable, so
  `.sqlfluff` sets `ignore = parsing`. That means the bodies are *not* linted
  — pgTAP is the only thing checking them.
- `AL03`, `CP01`, `CP02` are excluded because PostGIS type modifiers and the
  `PUBLIC` / `VALUE` keywords are misparsed as identifiers.

**`num_visible > total_splats` is a counter that was never zeroed, and it is why the step was slow**
- brush's render pass counts the visible splats and the tile intersections
  with two one-element atomic counters made by `int_zeros` (brush-render
  render.rs). On this build's burn the fill of a one-element tensor did not
  land on wasm, so the counters held whatever the pooled memory held before
  — the previous step's counts — and accumulated step over step. The panic
  is the assert on the visible count, and it fires on a tile every camera
  sees whole (our datasets: 180 000 seeded, all visible, over the total by
  the third step) and passes on a scene where a view sees a third of the
  splats — which is every dataset brush's own app ships with, and why the
  app was fine with those and panicked with ours. Before the assert fires
  the intersections count is over by the same factor, and it sizes every
  sort and raster pass after it: a step three times the work it should be,
  on wrong data, which is the 700 to 1 500 ms a step and the blur.
- `tools/brush-counters.patch` zeroes both counters by a host write
  (`int_from_data`) instead; `tools/build-brush.sh` applies it. The proof is
  the step time and the absence of the panic on a tile seen whole, nothing
  else.

**The brush revision was the problem, not our side of it**
- brush's web demo (github.com/ArthurBrussee/brush-demo) was last deployed
  2026-04-25, from brush e700993. Every revision vendored here since
  (5ee2053, ee797e9) came after brush moved onto burn's new runtimes
  (ce76c88, 2026-09-06), which nobody had run on the web: the autotune panic,
  the counters, the missing `enable subgroups;` were all that stack, and the
  patches only got it to run. It also trained wrong: on the same synthetic
  ground, 300 steps, SwiftShader, ee797e9 left the colours at the seed's grey
  (DC std 0.015) while 48ca31c learned the texture (0.61), at the same
  learning rate — and took 755 ms a step against 126.
- `tools/build-brush.sh` now pins 48ca31c: the first brush-js commit, a week
  after the demo's revision, same engine generation, no autotune patch, no
  counters patch. Before moving the pin forward, repeat that comparison.

**Brush's own app is the control, and the folder it gets has to be the trainer's**
- The way to check the trainer is `node tools/dataset.mjs <job>` and the
  folder in brush's web app (arthurbrussee.github.io/brush-demo). Since
  db/0186 the seed is one recipe (`client/lib/sampling.js` `seedOf`): the
  trainer's, the tool's, and assemble's own init.ply, which the dataset's
  transforms.json now names — so `--all` starts from it too, where before it
  started from random points. A difference between the app and the atom is a
  real one now: same seed, and a config that is brush's own except
  `sh-degree`, `max-splats` and the iteration count.
- The app failing with `[Invalid ShaderModule "main"] is invalid due to a
  previous error` is that build of the app against that browser, not the
  dataset: a dataset cannot change a kernel's source. The previous error is
  the first line in the console — the compiler naming what it refused; with
  Chromium after subgroups shipped it is `cannot call built-in function
  'subgroupAdd' without extension 'subgroups'`, the failure
  `client/lib/brush.js` `withSubgroups` shims for the vendored build. Load
  any other dataset in the app: if that fails the same way, that is the
  answer, and the app has been rebuilt since the one that trained.
- Six hundred milliseconds a step with the GPU idle is readbacks, not
  kernels: the `train` log lines carry `in_brush`, `ours`, `maps` and
  `map_ms` per step (`client/lib/brush.js` deviceStats). A refine is where
  most of them are, and the seed is what decides how much a refine has to do.

## 3. Conventions this code already commits to

- **Migrations are numbered and never edited once applied.** Add a new file;
  `CREATE OR REPLACE FUNCTION` to change behaviour. Files sort lexically, so a
  second file for the same number needs a suffix that sorts after the first
  (`0005_jobs.sql` → `0005_state.sql`). The highest applied is `0027_verifyguard`,
  so the next migration is `0028_*.sql`.
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

## 3a. What WP4.1 left for the rest of WP4

- **`canon-v1` is the only thing that may name an asset.** `client/lib/canon.js`
  produces the canonical GLB and its SAN; `derive_san()` in
  `db/0020_assets.sql` derives the same SAN from the same digest, and the
  database's answer is the one that counts. Both are covered by fixtures — if
  you change either, change both and re-run `db/test/0020_assets.sql`, whose
  first assertion is the fixture bench's digest.
- **A SAN is a function of the bytes, so tests collide.** Two runs that upload
  the same fixture hit the same asset row, and `register_asset` is a no-op the
  second time. `client/test/e2e/catalog.spec.js` builds its bench with a random
  texture for exactly this reason. Anything new that uploads must do the same.
- **`client/lib/thumb.js` renders the catalog picture** with `frame`'s renderer
  and `frame`'s sun, from the canonical GLB. WP4.2 can use `meshesOf()` to get
  the same asset as plain typed arrays for placement preview.
- **`similar_assets(name, tris, bbox)`** is the near-duplicate check, and
  `box_close` is what "the same shape" means.
- **The catalog page is `catalog.html` + `js/catalog.js` + `js/catalogui.js`**,
  split the way `play.html` is: policy and API calls in `catalog.js`, DOM in
  `catalogui.js`. `window.splatworld = { api, catalog }` is what the browser
  test drives.
- **Build mode is `js/build.js` (policy) + `js/buildui.js` (panel, input,
  gizmo) + `js/preview.js` (what is placed but not yet compiled)**, mounted by
  `play.html` and exposed as `window.splatworld.build`. `db/0021_build.sql` has
  `my_areas()`, `area_at()` and `tiles_at()` — every function there pins
  `SET search_path = public`, because PostgREST runs a request with
  `search_path = api` and an unqualified helper is then not found. That failure
  shows up only through the API, never in psql.
- **A panel's status line must keep its own class.** `say()` in `areasui.js`
  once assigned `className` outright, which dropped `area-status` and made the
  element vanish from every selector naming it. Change the modifier, never the
  whole list.
- **`assemble` places instances now.** An instance's asset digest comes from
  `tile_world`; `lib/glbmesh.js` turns a canonical GLB into triangles and
  refuses anything else. WP4.3's merge and WP4.4's purchases change who may
  place, not how.

## 4. What WP5 left behind

WP5 is the Switzerland seed, background rendering, the web GIS editor, XR and
ops. All five are in.

- **The Switzerland seed tools are gone** (`tools/seed-*.sh`,
  `tools/geo-common.sh`): the world's ground is the operator's coverage,
  cut per tile on request (`server/splatworld/ground.py`), and what stands on
  it is drawn in QGIS or imported (`docs/import.md`). `infra/seed/ch.geojson`
  remains as a region outline.
- **"Help render the world"** is two more entries in `caps` — `ops` and
  `near {lon, lat}` — which `claim_atom` already carried and already filtered
  on. `GET /api/progress` says how far the world has got, publicly.
- **`edit.html`** is the map: OpenLayers over `tile_world()` for reads and
  PostgREST for writes, permission-aware, with a writer's drawing an insert and
  an `edit` grantee's a proposal.
- **`?xr=1`** takes an 8 M splat budget and offers teleport locomotion. Not run
  on a headset — `docs/xr.md` is the list to work through when there is one.
- **Ops**: `tools/backup.sh`, `tools/restore.sh`, `tools/gc-jobs.sh`,
  `docs/runbook.md`, and PUT rate limits in `infra/nginx.conf`. The restore
  drill runs on every `make api-test` (`tools/ops-test.sh`).

What WP4 left behind, still true:

1. **WP4 is done**: the catalog, build mode, areas and proposals, and money.
   §3a above is the shape of it.
2. **Money is done and gated**: `pay`, `set_bounty`, escrow release,
   `buy_asset`, `transfer_asset_right`, the wallet panel and a real
   sixteen-client race on the last edition (`db/test/0023_buy.sh`). WP5.2's
   "help render the world" is what puts unbountied work in front of a tab.
3. **Areas, grants and proposals are done** (`db/0022_proposals.sql`):
   `propose`, `approve`, `merge_proposal`, `set_grant`, `revoke_grant`,
   `set_required_approvals`, `area_grants`, `my_proposals`. A diff is
   `{"ops":[…]}`; `client/js/areas.js` builds one and `areasui.js` shows it.
4. **Adding an op is a worked example now.** WP3 added two: an atom module
   under `client/atoms/`, a branch in `build_dag`, structural rules as rows, a
   pgTAP file and a browser spec. Copy the shape.
5. **One thing WP3 could not finish is waiting for WP4**: an atom belongs to
   exactly one job, so a rebuild of the same tile at a new `expected_version`
   reuses atoms owned by the old job and never publishes. That is why a
   `suspect` tile cannot be recompiled yet (PROGRESS deviation 55). Including
   the job's target version in `atom_hash` is the obvious fix and would want
   its own migration and a torture-test run.

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
make gate        # the concurrency test, the 30 s hot-swap poll, the pilot
                 # compile and WP3's trained tile are most of it. `make vendor`
                 # once first, or the browser tests skip.
```

Commit message `<story>: <title>` (`FL.8: the Planner — …`, `FND.5: …`). If you
deviate from the task file, say so in
the commit body and add a row to `PROGRESS.md` — every deviation so far is
recorded there, and that record is the reason this handoff is short.

### Writing the last story of a run without paying for the whole run

`make player-run` is the gate and it is an hour and a half from an empty
database. Iterating on its last story that way is not a loop anybody can
work in, so:

```
bash tools/replay.sh save after-25          # a run that got that far
bash tools/replay.sh load after-25
RUN_KEEP_WORLD=1 make player-run RUN_ARGS=client/test/run/26-*.spec.js
```

`replay.sh` saves the database, the file store and the `ALTER DATABASE`
settings a dump never carries (the JWT secret and the run's small render
numbers, without which nobody can sign in), and puts all three back.
`RUN_KEEP_WORLD=1` is the only thing that stops the fixture emptying the
world; nothing but a developer's own shell ever sets it, and the gate is
still the whole run from empty. A story is green when that is green.

### What is left, and what it needs

Nothing in `docs/history/TASKS.md` is unticked. Four things are unrun rather than undone, and
each is a numbered deviation in `PROGRESS.md`:

1. **WP3.1's acceptance, on a GPU** (deviation 57). `train.spec.js` trains a
   real z16 tile over SwiftShader at a size that finishes. It used to assert
   that training improved the held-out PSNR, and that was called stochastic;
   it is not. Measured over four consecutive runs on this box the held-out
   views end **0.01–0.06 dB below** the initialisation, every time, and
   raising the iterations from 80 to 400 — five times the work — changes
   neither the sign nor the size of it. So on a software adapter the spec now
   holds the trainer to not wrecking the tile (within 0.5 dB) and keeps the
   improvement assertion for a real GPU, which it detects by the adapter's
   description.

   That leaves a real question for whoever has the hardware: either the
   optimiser needs a GPU to make progress at all, or it is not learning and
   SwiftShader is only where it shows. The machinery around it is proven —
   the tar, the sog, the candidate, the publish, the stream. (The trainer
   this was measured on has since been replaced by brush, see §2.)
2. **WP5.4's acceptance, on a headset** (deviation 102). `docs/xr.md` is the
   list.
3. **The whole of Switzerland, seeded** (deviation 91). Superseded: the seed
   tools are gone and the ground is the operator's own coverage (§4).
4. **WP0.11's QGIS round trip.** Done since by story 3 of the player-run: a
   headless QGIS draws over a direct connection as the player
   (`client/test/run/qgis.js`).

One thing WP3 could not finish is still open: an atom belongs to exactly one
job, so a `suspect` tile cannot be recompiled (deviation 55). Including the
job's target version in `atom_hash` is the obvious fix, and it wants its own
migration and a torture-test run.

`CLAUDE.md` says to ask before changing a table that already has a migration,
changing an RPC signature, or adding a dependency. Several of those came up in
WP0 and WP1 and are documented as numbered deviations in `PROGRESS.md`; treat
the list as binding. The dependencies added so far are dev tooling only —
eslint and `@playwright/test` — and the client itself still has none.

## Running Postgres without Docker

`infra/compose.yml` has still never been started in a session; no Docker daemon
has been available. A plain cluster runs every migration and every pgTAP test:

```
apt-get install -y postgresql-16-postgis-3 postgresql-16-pgtap
D=/var/lib/postgresql/sw
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $D/data -U postgres --auth=trust"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D/data -l $D/log \
    -o '-p 5432 -k /var/run/postgresql' start"
PGHOST=/var/run/postgresql PGUSER=postgres make db-reset
```

Two traps paid for:

- **Do not put the data directory under the session scratchpad.** Its
  permissions get reset underneath a running server; the checkpointer then
  PANICs on `pg_control` and the cluster shuts itself down mid-run. Use a
  directory `postgres` owns.
- `pg_prove` is not in the Ubuntu packages, so `make db-test` cannot run as
  written. Until it is installed, each file runs under
  `psql -f db/test/000x.sql` — pgTAP prints TAP either way, and counting
  `^ ok` against `not ok` is the whole check. The suite is 502 assertions
  across 31 files.

## 7. The foundation work (TASKS-foundation.md)

`TASKS-foundation.md` is the task list after `PLAYER-RUN.md`'s fifteen
stories; `PLAN-foundation.md` holds the decisions it implements. FND.0 laid
the groundwork:

- **Fixtures.** `tools/make-seed-osm.sh` and `tools/make-seed-cover.sh` cache
  `infra/seed/{osm-visp.gpkg,tlm-visp.gpkg,worldcover-visp.tif}` beside the
  DEM. **Overpass, Geofabrik and `data.geo.admin.ch` are all denied at this
  container's egress; `*.amazonaws.com` is not.** So WorldCover is real and
  the other two are stand-ins written by hand in the real sources' own shape
  and keys (`infra/seed/README.md` says which is which, and both scripts say
  so on every run). On a networked box the same scripts write the real thing.
- **Models.** `tools/make-fixture-models.mjs` (on `tools/glbkit.mjs`) writes
  the eleven GLBs the stories place — lamp with a `head` node, billboard with
  a `screen`, portal with a `mouth`, a 2 m wall segment, a 1 m kerb. CC0,
  made here, because every CC0 host is denied too
  (`client/test/fixtures/assets/NOTICE`).
- **Cover over WMS.** `tools/geoserver_cover.py` publishes a cover source as a
  class raster — a vector one is burnt to codes with GDAL first — and
  `tools/geoserver-fixture.py --cover NAME=PATH[:FIELD]` serves it. The class
  style is a colour per code, injective, written in that module's docstring:
  it is what FND.12's downloadable SLD has to reproduce.
- **The views.** The apps drawer is Build · Automate · Work · Trade & Sell ·
  Play · Survey (F1–F6), the operator's naming; only Build is wired, the rest
  say so on their cards. SPEC §2.1.

**This machine gives two 3D pages a WebGL context, and not three.** A third
`play.html` draws its chrome, says "nowhere yet" and never gets an engine —
`window.splatworld` is never assigned, so every assertion about the world line
times out. Closing one of the other two lets it boot. `--max-active-webgl-contexts`
does not help; it is memory, not the context count. A story with three players
in it closes one tab before opening the next (client/test/run/08-rendering.spec.js).

**`make player-run` is green through all fifteen stories**, about twenty-three
minutes, and the tiles are built small: `db/0131`'s `splatworld.budget_scale`,
`splatworld.iters` and `splatworld.frame_px`, set on the database by
`client/test/run/world.js` after every reset. `RUN_FULL_SIZE=1` renders at the
operator's own numbers, which is hours a tile without a GPU. The claim lease is
turned down the same way (`db/0132`, `splatworld.lease`), and it must stay
above the half-minute a tab beats at (`client/js/work.js`).

**`ALTER DATABASE` persists, and the run happens in the operator's own
database.** A run that set those four numbers and walked away left the world
being built at a twentieth of the budget for good — every tile rendered
afterwards came out poor, and every claim was leased for 150 seconds, which
takes a training run away from the tab that is doing it. `startWorld` now
records what it found and puts it back when the run ends, and the page says
what the world is built at (Work · Settings, `db/0173` `world_size`). A world
that went through an older run is still turned down: the panel says so and
prints the `ALTER DATABASE … RESET` that undoes it.

**Run `make gate` from a reset, not straight after `make player-run`.** The
run leaves a whole world behind — land, published tiles, leaf jobs — and
`tools/test-tiles.sh` then meets tiles that are already somebody's job and
cannot publish its fixture into them ("no verified sog of yours"). `make gate`
starts with `db-test`, which resets; running `client-test` on its own after a
player-run does not. `rm -rf infra/files && make db-reset` first.

**`make gate` is green end to end again**, from an empty database, in about
twenty-five minutes; the browser suite is nine of them. Six browser tests do
not run here and say why: three need a GPU (a tile is trained at every zoom
now, and `client/test/e2e/worker.js` holds the sentence and the WebGPU launch
flags), three are the suite's own conditionals. PROGRESS.md lists them.

**The gate was red when this work started**, at `b943ce3`, in ways FND.0 did
not touch: fifteen `db/test/*.sql` files assert the DAG as it was
before `db/0121`–`0126` (z14 is framed from stations now, so "z14 DAG = 1
assemble, 1 sample, 1 sog" cannot hold), and `make lint` failed on four files
plus two linter upgrades. All of it is fixed in the two commits after FND.0, and two of those failures
were the world's rather than the tests': a leaf tile below z14 was being
merged out of children that do not exist (db/0128), and a bounty could pay out
a shade more than it held (db/0129).

## 8. The flow editor (FND.1)

**`client/flow/` is a copy, not a fork.** Every file there says in its header
which file of `wireon-process-editor` it came from, at which commit, and what
changed. Keep it that way: when one of those modules has to change, change it
and extend the header's `changes:` list rather than quietly editing a copy. The
copies keep the reference repository's formatting (two spaces, double quotes),
so `eslint.config.js` turns style off for `client/flow/**` and leaves every
rule that catches a mistake on — including the 400-line rule, which is why
`theme.js` is three files here.

**The copies are held honest by their own tests.** `client/test/e2e/flow/` is
that repository's suite, with the imports pointed at `/flow/` and the fixtures
at `/flow/palette` and `/flow/samples`; `client/test/e2e/flow-modules.spec.js`
opens the page and fails if any of them does. Three of them were red at the
source and carry the correction in their header — do not "fix" them back.

**litegraph is a classic script.** It attaches `LiteGraph`, `LGraph` and
`LGraphCanvas` to `window`, there is no module build of it, and this repository
has no bundler. `client/flow/boot.js` loads it (and `flow.css`, and litegraph's
own stylesheet) the first time somebody opens Automate, and never at page load.
Nothing may `import` it.

**The palette is static files and a list of them.** A browser cannot read a
directory, so `client/flow/palette/manifest.json` says what is in
`client/flow/palette/plugins/`. Add or remove a plugin and run
`bash tools/palette.sh`; `client/test/palette.test.js` is the gate that notices
if you forget. opencv's trained model is deliberately absent — see its NOTICE.

**Layout is never in the ELX, and no longer in localStorage.** The reference
editor kept node positions in the browser; here they are `flow.layout` in the
world, so a flow looks the same on the next machine. That is the whole of what
`client/flow/graph/layoutstore.js` changes about the file it was copied from,
and `client/test/run/16-drawing-a-flow.spec.js` asserts the ELX has no
coordinates in it.

**While Automate is open the world is not drawn.** `client/play.html` sets a
`paused` flag and `app.autoRender = false`; the update handler returns at once.
A story that opens Automate and then expects the position line to move has to
close it first.

**Validate's local half reads the file, not the canvas** (FND.2). litegraph
vetoes an invalid connection as it is made and `importFlow` drops one it cannot
make, so a canvas is always locally valid and checking it would find nothing
ever. `client/js/flowsdo.js` hands `localProblems` the bytes that would be run —
the canvas's when something is unsaved, the saved file's otherwise. A test that
wants a local problem has to import a file that has one; it cannot draw one.

**An export is the saved bytes.** Do not "simplify" it to `canvas.elx()`: the
serializer's element order is not the process server's, and story 17 compares
the exported file to the imported one byte for byte. The same reason is why
`importFiles` saves the arriving file and then only the layout.

**The vocabulary is OSM's** (FND.3, db/0157). A kind is a key — `highway`,
`landuse`, `natural`, `building`, `natural_point`, `railway`, `aerialway`,
`barrier`, `waterway` — and which one it is is a property of the same name. When
you write a fixture, a seed or a test that inserts a feature, give it both: a
`landuse` with no `landuse` is drawn as nothing, on purpose.

**A migration that seeds data has to be idempotent.** `migrate.apply` replays
every file against a database that already has them whenever the ledger is
missing, and forgives only "already there" errors. A bare `INSERT` is neither:
it either duplicates itself or fails on a constraint a later migration added.
Guard it with `WHERE NOT EXISTS`, as db/0037 now does.

**A view over a table does not grow with it.** `api.asset` was
`SELECT * FROM public.asset`, and `*` is expanded once — when the view is
created. FND.5 added two columns to `asset` and the page's read came back 400
until db/0159 replaced the view. Any migration that adds a column to a table the
API exposes has to replace that table's view in the same file.

**Do not edit client/ while a player-run is going.** The page is served from
disk on every navigation, so a spec that started before the edit meets the code
after it — and a story that had nothing to do with the change fails in a way
that reads like a real bug. Wait for the run, or run the affected stories only.
