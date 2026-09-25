# Code map

What each directory and file is, as the tree stands. Why it is built this way
is `ARCHITECTURE.md`; what the player meets is `docs/SPEC.md`. Where a file's
header comment disagrees with this map, the file wins.

## Top level

| path | what |
|---|---|
| `db/` | the schema: numbered SQL migrations, and `db/test/` (pgTAP + shell) |
| `server/` | the `splatworld` Python package: file store, static client, PostgREST supervisor, CLI; `test_*.py` |
| `client/` | everything the browser runs: pages, modules, atoms, flow editor, vendored code, tests |
| `tools/` | gates, fixtures, test servers and operator scripts; run on a dev box, never by the server |
| `infra/` | `compose.yml`, `nginx.conf`, `postgrest.conf`, seed fixtures |
| `gis/` | the QGIS project (generated) and the script that saves shaped ground from QGIS |
| `docs/` | product spec, design artboards, manuals, finished task files (`docs/history/`) |
| `Makefile` | the gates: `db-reset db-migrate db-test api-test client-test flow-test lint gate player-run`, plus `vendor` and `up/down/logs` (compose) |
| `package.json` | dev-only: `@playwright/test`, `eslint`. The client has no npm dependencies |
| `playwright.config.js` | browser specs in `client/test/e2e`, page served by route interception, SwiftShader GL |
| `eslint.config.js` · `.sqlfluff` | lint config (eslint built-in rules only; sqlfluff postgres dialect) |
| `.env.example` | every variable the Makefile, compose and `splatworld` read |

## client/

Plain ES modules served as static files; no build step.

### Pages

| page | what | boots |
|---|---|---|
| `play.html` | the whole game: viewer, chrome and every panel (setup, land, catalog, work, Automate, settings) | loads PlayCanvas from `vendor/playcanvas/` or the CDN, then `js/play.js` `startPlay` |
| `edit.html` | the web GIS editor on OpenLayers (WP5.3) | `js/editui.js` `mountEditor`, with `api.js`, `auth.js` |
| `view.html` | read-only viewer over a folder `tools/export-world.mjs` wrote; asks no database | inline module: `tiles.js`, `player.js`, `sky.js`, `origin.js` |
| `catalog.html` `setup.html` `import.html` `rules.html` | redirects to `play.html`; each is a tab of it now | — |
| `version.txt` | client version; `splatworld/__init__.py` `__version__` must equal it (setup page flags a stale server) | — |

CSS: `hud.css` `top.css` `bar.css` `frame.css` `panel.css` `panels.css` `work.css`
`symbols.css` `terrain.css` `objflows.css` are linked by `play.html`;
`flow.css` `flowsrv.css` `planner.css` are added by `flow/boot.js` when Automate opens.

### client/js/ — by concern

**The page** (`play.html` boots `play.js`; every module shares one `ctx`)

| module | what |
|---|---|
| `play.js` | the order things are mounted in; the chrome; auth; `window.splatworld`, the handle the browser tests fly |
| `playsetup.js` | Setup, Vocabulary, Symbols, Ground cover, land assignment, what is waiting, the catalog |
| `playview.js` | tile rows, floating origin, graphics device, camera, sky, streamer, spot checks, floor, ground mesh, player |
| `playwhere.js` | links in (`goTo`), the address bar, the land under the player (`whereAmI`) |
| `playbuild.js` | the placed-things preview, wallet, live things and movers, Place, Your land, Shape |
| `playapps.js` | Automate and Pick in world, the workspaces that take the window, Profile |
| `playpublish.js` | Submit, the render pool, Approve, map search, Share, grants and proposals |
| `playxr.js` · `playticks.js` · `playframe.js` | the headset; what is redrawn on a timer (map, next step, live things); every frame |

**Auth, API**

| module | what |
|---|---|
| `api.js` | the only PostgREST client; holds the JWT, mirrors it into sessionStorage |
| `auth.js` | sign-in / register panel |

**Viewer, tiles, walking**

| module | what |
|---|---|
| `tiles.js` · `tileengine.js` · `traverse.js` | tile entities and republish poll; the PlayCanvas-specific fields; which tiles should be on screen (pure) |
| `origin.js` | floating origin (rebase every 5 km) |
| `player.js` | kinematic player over heightmap + boxes |
| `floor.js` · `ground.js` | walkable floor and drawn ground where nothing is published yet |
| `sky.js` · `xr.js` | sky and air; headset budget and locomotion (`?xr=1`) |
| `visit.js` · `places.js` | address bar as a place, share links; map search box |
| `preview.js` | placed assets drawn as meshes until their tile is recompiled |
| `live.js` · `livedraw.js` | live parts' state (FND.15), drawn over the world |
| `movers.js` · `moverdraw.js` | route movers by the world clock (FND.16), drawn |
| `spot.js` | owner's free spot check of published tiles (Invariant 8) |

**Chrome**

| module | what |
|---|---|
| `hud.js` · `hudsays.js` | the chrome and its tabs; the sentences it says |
| `topbar.js` · `tabbar.js` · `apps.js` | top strip; plinth and surface list; views drawer |
| `chrome.js` · `altimeter.js` · `hudmap.js` | compass/place line/controls; altimeter; 240 px minimap |
| `nextstep.js` · `attention.js` · `notify.js` · `empty.js` | next-step card; waiting-for-you chip; notifications; empty-panel text |

**Land, areas, permission**

| module | what |
|---|---|
| `land.js` · `landui.js` · `landpeople.js` | Your land panel: data; nodes; grants and approvals sections |
| `landback.js` · `landfine.js` | giving land back; compile depth and "compile again" |
| `getland.js` | what a player with no land sees |
| `assignland.js` · `assignform.js` · `handover.js` · `landmap.js` | admin: land requests, assigning, taking back; its map |
| `areas.js` · `areasui.js` | grants and proposals; the area panel |
| `permission.js` · `permissionui.js` | Approve panel: submissions waiting for a person |

**Build (Place panel)**

| module | what |
|---|---|
| `build.js` | build policy: where one may build, where the thing lands |
| `buildui.js` · `buildhtml.js` · `buildrows.js` · `buildsay.js` | panel, input and gizmo; markup; lists; what it says |
| `portsui.js` · `screensui.js` · `moversui.js` | ports by hand; billboard screens awaiting a word; movers |
| `objectflows.js` · `rundialog.js` | a thing's flows (FL.6); Run on… / Stop (FL.7) |
| `roadcheck.js` | roads on a land that cannot be driven across (FND.11) |

**Sculpt (FND.9)**

| module | what |
|---|---|
| `sculpt.js` · `sculptbrush.js` | a land's height grid and strokes; what each brush does |
| `sculptui.js` · `sculptmode.js` · `sculptrail.js` · `sculptpan.js` | Land → Shape panel; in-world feedback and keys; tool rail; panning while shaping |
| `oldshapes.js` | converts retired terrainmod shapes into the height grid |

**Catalog**

| module | what |
|---|---|
| `catalog.js` | search, view, add an asset (canon-v1 in the tab) |
| `catalogpanel.js` · `catalogui.js` | the Catalog tab; its DOM |
| `catalogupload.js` · `catalogmarks.js` · `catalogtypes.js` | Register: GLB upload; live parts; non-model product types |
| `modelpreview.js` | the model in the Register form, parts live |

**Work: compiling in the tab, the pool**

| module | what |
|---|---|
| `work.js` | the loop: claim, fetch inputs, run, upload, register, submit |
| `workcaps.js` · `atomworker.js` · `inputs.js` | tab capabilities; the Web Worker that imports `atoms/{op}.js`; resolving an atom's inputs to bytes |
| `workstore.js` · `workshots.js` | PUT/lookup in the file store; pictures of tiles worked on |
| `workui.js` · `worksettings.js` | what this machine is doing; Work → Settings |
| `renderpool.js` · `poolcard.js` · `jobdetail.js` | Work queues as cards; one card; a job opened |
| `pool.js` · `poolui.js` | Submit and the render pool; their nodes (also exports `el`, used widely) |

**Settings, admin, wallet**

| module | what |
|---|---|
| `setupui.js` · `setupground.js` | Setup: account, GeoServer, ground; re-cut ground / redo frames |
| `adminui.js` · `vocabui.js` | Settings · Vocabulary |
| `symbolsui.js` · `symbolhtml.js` · `symbollist.js` · `symbollayers.js` · `symbolform.js` · `symbolpreview.js` · `symboltry.js` | Settings · Symbols (FND.7–8) |
| `coverui.js` · `coverform.js` · `covergrid.js` · `covermap.js` · `coversld.js` · `covertile.js` · `covertrace.js` | Settings · Ground cover and per-land cover (FND.12–13) |
| `wallet.js` · `walletui.js` · `profileui.js` | money and its panel; profile card |

**Web editor (`edit.html`)**: `edit.js` (feature policy and REST), `editmap.js` (OpenLayers), `editui.js` (panel).

**Automate (flows) and process servers**

| module | what |
|---|---|
| `flowsui.js` · `flowsbar.js` · `flowsdo.js` · `flowstatus.js` | the Automate view; its bar; its actions; canvas overlay |
| `flowlist.js` · `flowcanvas.js` · `flowinspector.js` · `flowpalette.js` | left column; litegraph canvas; right column; searchable palette |
| `flows.js` · `flowfiles.js` · `flowcheck.js` | save/load a land's flows (db/0155), bundled palette; import/export .elx; validate |
| `flowblocks.js` · `flowworld.js` · `pickworld.js` | blocks of the chosen server (FL.2); World block inspector (FND.14); pick-in-world |
| `processservers.js` · `serverpicker.js` · `servertab.js` | a player's process servers (FL.1, db/0196); picker; "On ‹server›" tab |
| `serverdo.js` · `serverprocs.js` · `serverservices.js` · `serverjobs.js` · `serverreports.js` · `jobdialog.js` · `scheduleui.js` | processes, services, jobs, reports on a server (FL.3–5); a cron trigger edited as a schedule |
| `flowrun.js` · `runlog.js` | run a world flow on a server (FL.7, db/0198); run log table |
| `planner.js` · `plannerui.js` · `plannerchart.js` · `plannerpop.js` | the Planner: server jobs on a timeline (FL.8) |

### client/atoms/ — one module per op, loaded by `js/atomworker.js`

`ALGO` in each file is the current version; `client/test/algo.test.js` checks it
against `algo_current()` in the database. File header comments lag behind.

| op | ALGO | what |
|---|---|---|
| `dataset.js` | `dataset-v8` | one tile, one tar: `assemble` + every frame + `transforms.json` (FND.5) |
| `assemble.js` · `assembleload.js` · `assemblelocal.js` | `assemble-v17` | the tile as geometry; fetching its inputs; features into tile metres |
| `frame.js` | `frame-v11` | render a range of a camera set (raster or path traced) |
| `train.js` | `train-v22` | brush (WebGPU/wasm) trains the tile from its dataset |
| `merge.js` | `merge-v1` | 16 grandchildren → parent, bit-exact |
| `sog.js` | `sog-v3` | ply → `.sog` |
| `verify.js` | `verify-v1` | perceptual check against held-out frames (probabilistic) |
| `noop.js` | — | computes nothing; exercises the worker loop in tests |

### client/lib/

| module | what |
|---|---|
| `tilemath.js` · `crs.js` · `geo.js` | mirror of db/0004 tile maths; the two SRIDs; reading `/geo/dem` tiles |
| `hash.js` · `tar.js` · `opfs.js` · `quickyield.js` | sha256; deterministic ustar; OPFS directory; background-safe yield |
| `canon.js` · `canonmesh.js` · `canontex.js` · `glb.js` · `png.js` · `draco.js` | canon-v1 GLB normal form: scene, geometry, materials, container, PNG codec, Draco decode |
| `glbmesh.js` · `mesh.js` · `assets.js` · `thumb.js` | GLB to triangles; per-material mesh buffers; fetch GLBs by digest; catalog thumbnails |
| `marks.js` · `product.js` · `symbols.js` · `rules.js` | live-part marks (FND.6); non-model products; symbol layer schema; rule matching |
| `terrain.js` · `skirt.js` · `props.js` · `poly.js` · `sampling.js` | tile ground mesh and heights; edge skirt; roads/footprints/water/trees; polygon maths; surfaces → seed splats |
| `r32.js` | `.r32`, a land's shaped ground as a file (FND.9) |
| `brush.js` | the trainer: seam over `vendor/brush` (not the sculpt brush, which is `js/sculptbrush.js`) |
| `cameras.js` · `frames.js` · `dataset.js` | camera sets; reading frame tars; nerfstudio dataset for brush |
| `raster.js` · `pathtrace.js` · `denoise.js` · `render.js` · `light.js` | three.js raster and path-traced frame renderers; denoiser; small WebGL2 forward renderer; the one sky |
| `gsmath.js` · `gsmodel.js` · `gsrast.js` | gaussian projection, parameterisation, CPU rasteriser (used by `verify`) |
| `ply.js` · `sogenc.js` · `lodorder.js` · `preview.js` | ply I/O; SOG v1 encoder; LOD prefix ordering; cheap splat picture |
| `demshade.js` · `route.js` | hillshade for the minimap; mover position at a time |

**`client/lib/gen/`** — generator layers a symbol is built from (FND.7):
`index.js` (dispatch, layer by layer), `surface.js` (roads/areas laid on the
ground), `extrude.js` (footprints), `place.js` (model on a point), `repeat.js`
(piece along a line), `scatter.js` (Poisson disc), `paint.js` (ground material
request), `check.js` (builds nothing, reports), `cover.js` · `covercolour.js`
(ground cover and its colours, FND.12), `trace.js` (class raster → shapes,
FND.13), `terrainmod.js` (retired shaping op, on its way out).

### client/flow/ — the Automate editor

Most files are copied from `wireon-process-editor` at `ab52530`; each header
says so and lists any change. `client/test/e2e/flow-modules.spec.js` runs that
repo's suite (`client/test/e2e/flow/*.test.js`, `page.html`, `runner.js`)
against the copies.

| path | what |
|---|---|
| `boot.js` | loads litegraph (classic script) and the flow CSS on demand; `registerPlugins`, `bootFlow` |
| `elx/` | `parse.js` `serialize.js` `ir.js` `nets.js`: ELX XML ⇄ flow IR |
| `graph/` | IR ⇄ litegraph: `import.js` `export.js` `register.js` `subflow.js` `portgroup.js` `hideoutputs.js` `namednets.js` `history.js` `layout.js`; `layoutstore.js` (layout lives in `flow.layout`, not localStorage); `theme.js` `themedraw.js` `themetokens.js` (one upstream file split for size) |
| `plugins/` | `parse.js` (plugin.xml → block defs), `registry.js` |
| `palette/` | the bundled block set: `plugins/<id>/plugin.xml` (+ composite `assets/`), `manifest.json` written by `tools/palette.sh` (also lists `../world/plugin.xml`) |
| `world/` | the `world` plugin: `plugin.xml` + `assets/nodes/` (port read/write, mover set, clock now, events since), FND.14 |
| `samples/` | two exported `.elx` files for the round-trip test; nothing in the world uses them |
| `server/` | talking to a process server (F10): `client.js` (requests, CORS diagnosis), `envelope.js`, `process.js`, `records.js` (services/jobs/reports), `params.js`, `inputs.js`, `cron.js`, `schedule.js` (presets and their sentence) |

How it fits: a flow is an ELX file stored as an artifact plus a `flow` row
(`save_flow`, CAS on `rev`). The page draws it with litegraph over the bundled
palette plus whatever blocks the chosen process server reports. A process
server is a player's own external service (db/0196); the browser talks to it
directly, so the server has to send CORS headers for the page. A
flow that runs there reaches back into the world through PostgREST with a key
of its own (db/0198), as a player under RLS (Invariant 9). `docs/flow.md` has
the detail.

### client/vendor/

| dir | what | how pinned |
|---|---|---|
| `three/` | three.js 0.186.0, three-mesh-bvh 0.9.15, three-gpu-pathtracer 0.0.24 (frame renderers) | checked in; bumped via `tools/vendor.sh` |
| `brush/` | brush trainer, wasm + JS bindings | checked in; built by `tools/build-brush.sh` at `COMMIT` (48ca31c) with `tools/brush-*.patch` |
| `litegraph/` | flow canvas | checked in; upstream commit 0555a2f (`NOTICE`) |
| `playcanvas/` `draco/` `ol/` `fonts/` | engine 2.22.0, draco3d 1.5.7, OpenLayers 10.10.0, web fonts | gitignored; `make vendor` fetches. Pages fall back to the CDN |

### client/test/

| path | what | run by |
|---|---|---|
| `*.test.js` (68) | node unit tests, one or two modules each (tilemath, canon, sog, cover, sculpt, algo versions, palette manifest, …) | `make client-test` (`node --test`) |
| `e2e/*.spec.js` | playwright specs, mostly the WP-era acceptances (work, frame, merge, sog, train, stream, catalog, money, xr, …); skip without DB, vendor or GPU | `make client-test`; `make flow-test` runs only `flow-*.spec.js` |
| `e2e/{serve,services,worker,publish}.js` | helpers: route-served client; PostgREST + file store; worker fixtures; publish a tile through the real RPCs | e2e specs |
| `e2e/flow/` | the reference editor's own tests, in a page | `flow-modules.spec.js` |
| `fixtures/` | `tilemath.json` (from `tools/tilemath-fixtures.mjs`); `assets/` GLBs and PNGs (from `tools/make-fixture-models.mjs`, `make-asset-fixtures.mjs`, `make-fixture-materials.mjs`) | unit and e2e |
| `run/NN-*.spec.js` | **the player-run**: `00` harness check; `01–13` SPEC §3 stories and `14` compiling again, `15` moving (`PLAYER-RUN.md`); `16–31` `TASKS-foundation.md`; `32–39` `TASKS-flows.md` | `make player-run` (`run/playwright.config.js`, stops at first failure) |
| `run/{world,players,pixels,qgis,elx,automate}.js` | empty world + server + GeoServer fixture; player helpers; 3D-view pixel checks; headless QGIS; process-server fixtures; Automate gestures | player-run |
| `run/qgis/*.py` | PyQGIS: `draw.py`, `import.py` (paste OSM), `shape.py` (edit height raster) | `run/qgis.js` |
| `run/fixtures/weather.xml` | a plugin only process server `alpha` has | `run/elx.js` |

## server/

`pip install -e ./server`; entry point `splatworld = splatworld.__main__:main`.
Dependencies: `psycopg`, `rasterio` (import only).

| module | what |
|---|---|
| `__main__.py` | CLI (below) |
| `__init__.py` | `__version__`, kept equal to `client/version.txt` |
| `config.py` | settings from env, `.env`, flags; ports (files 8081, API 3000) |
| `migrate.py` | create DB, apply `db/*.sql` in order, ledger table `migration`, advisory lock |
| `services.py` | starts, waits for and stops PostgREST (and puts libpq on PATH on Windows) |
| `serve.py` | HTTP on one port: `/app/` (client), `/assets /tiles /jobs /geo` (GET immutable, PUT via `can_write`), `/tiles/cover/…png`, `/qgis/{project.qgs,credentials,save-ground.py}`, `/setup/{state,geoserver,probe}` (this machine only), `/healthz` |
| `ground.py` · `dem.py` | cut `/geo/dem/{z}/{x}/{y}.r16` from the operator's WCS on first request; the dem encoding |
| `geoserver.py` | parse WFS/WCS GetCapabilities for the Setup panel |
| `png.py` · `geotiff.py` | stdlib PNG compose (cover sources); `.r32` → GeoTIFF for QGIS |
| `qgis.py` | writes `gis/splatworld.qgs` from the world's vocabulary |
| `importer.py` · `postgis.py` | `splatworld import`: layers from WFS, GeoJSON or local PostGIS tables |
| `crs.py` | the two SRIDs, mirrored from db/0056 |

Commands (`splatworld <cmd>`; each also takes `--host`, `--port`, `--api-port`, `--verbose`):

| command | does |
|---|---|
| `run [--no-browser]` | creates DB / applies pending migrations, starts PostgREST and the server, opens `/app/play.html` |
| `init [--reset]` | create the database and apply the schema (`--reset` drops it) |
| `doctor` | print what is resolved and what is missing |
| `import <region.json>` | import map layers (`docs/import.md`) |
| `qgis` | rewrite `gis/splatworld.qgs` |
| `ground z/x/y` | ask the GeoServer for one tile's elevation and report |

Tests (`server/test_*.py`, pytest, run by `make api-test`; `pip install -e "server[test]"`): `test_crs`,
`test_crs_agree` (EPSG spelled once; SQL/JS/Python grids agree), `test_migrate`,
`test_dsn`, `test_libpq`, `test_projenv`, `test_stale` (running code older than
checkout), `test_serve_put`, `test_geoserver`, `test_ground`,
`test_coverage_edge`, `test_nodata_ground`, `test_postgis`, `test_qgis`. The
ones needing PostGIS skip without it.

## db/

- **Naming.** `NNNN_name.sql`, applied in lexical order by `make db-migrate`
  and `migrate.py`. 204 files, 0001–0198. Numbers repeat where two branches
  met: 0005, 0008, 0017, 0044, 0050, 0095. Early names are nouns
  (`0005_jobs`); from ~0068 a name is the behaviour as a run-together
  sentence (`0098_compileagainmeansagain`). The first line of each file says
  what it does (0155–0165 still name themselves 0133–0143 there, their
  numbers before a renumbering). A fix is a new file (`0055` undoes `0054`).
  Applied files are recorded in the table `migration` by `migrate.py`.
- **Rough eras**

| range | what |
|---|---|
| 0001–0027 | WP0–WP4: schema, auth/JWT, RLS, tile maths + dirty trigger, jobs and atom state machine, publish CAS and money, `api` schema, file authorisation, verification, spot checks, trust, assets, build, proposals; 0026–0027 review fixes |
| 0028–0041, 0046 | QGIS over GeoServer WFS-T (`gis` schema, forms), rules and properties as data, ground |
| 0042–0064 | TASKS-usable: your land, pool, permission, CRS once (0049, 0053, 0056, 0060), land requests |
| 0065–0072 | QGIS as the player (0065 roles, 0066 drop the proxy), approval first, place search |
| 0073–0154 | rendering quality and pool mechanics: sky, brush trainer (0095), ground layers (0106), renderer choice (0107), seed sizes, LOD levels (0134–0137), pool pages and redo |
| 0155–0177 | TASKS-foundation: flows (0155), OSM vocabulary (0157), product types and ports (0159–0160), symbols (0161–0162, 0175), painted ground (0163–0165), cover (0166–0167), world blocks (0168), live/events/movers (0169–0172) |
| 0178–0195 | pool hand-out by capability, one tile one folder (0183), trainer/dataset versions (train-v20…22, dataset-v6…8) |
| 0196–0198 | TASKS-flows: process servers, flows on things, run keys |

- **db/test/**: 145 pgTAP files named after the migration they test
  (`BEGIN; SELECT plan(n); … SELECT finish(); ROLLBACK;`), run by `pg_prove`;
  four `.sh` tests that need several sessions (`0006_concurrency`,
  `0023_buy`, `0065_playerroles`, `0110_twotabsaskforthesametile`), run after.
  `make db-test` resets the DB first.

## tools/

| script | what | called by |
|---|---|---|
| `api-test.sh` | PostgREST smoke: register, login, RLS, RPCs | `make api-test` |
| `files-test.sh` | file-store contract (401/403/201/409, immutable GET) for nginx or `serve.py` | `make api-test` |
| `ops-test.sh` | backup/restore/gc drill on scratch DB and store | `make api-test` |
| `backup.sh` · `restore.sh` · `gc-jobs.sh` | back up DB + store; restore or check drift; delete old `/jobs` bytes | by hand (`docs/runbook.md`); `ops-test.sh` |
| `test-tiles.sh` · `make-test-tiles.mjs` · `testterrain.mjs` · `sogwrite.mjs` | publish synthetic z10 test tiles through the real pipeline; its terrain; node SOG writer | `make client-test`; e2e specs |
| `tilemath-fixtures.mjs` | regenerates `client/test/fixtures/tilemath.json` from the DB | by hand |
| `make-asset-fixtures.mjs` | the five exporter-variant GLBs canon-v1 must agree on | imported by `canon.test.js` and e2e |
| `make-fixture-models.mjs` · `glbkit.mjs` · `make-fixture-materials.mjs` | the foundation fixture models and materials | by hand (output committed) |
| `make-seed-dem.sh` · `make-seed-osm.sh` · `make-seed-osm-standin.py` · `make-seed-cover.sh` | player-run seed data around Visp (DEM, OSM or stand-in, cover) into `infra/seed/` | `client/test/run/world.js` |
| `geoserver-fixture.py` · `geoserver_cover.py` | stand-in GeoServer (WCS elevation, WMS cover) | `run/world.js` |
| `elx-fixture.py` · `elx_fixture_routes.py` | stand-in process server (`/api/v1`, CORS on) | `run/elx.js` |
| `replay.sh` | save/restore a player-run's world to rerun a late story | `run/world.js` |
| `palette.sh` | writes `client/flow/palette/manifest.json` | by hand; checked by `palette.test.js` |
| `vendor.sh` | fetches gitignored vendor code at pinned versions | `make vendor` |
| `build-brush.sh` + `brush-{autotune,counters,readback}.patch` | builds `client/vendor/brush` from pinned brush | by hand (Rust + wasm-pack) |
| `dataset.mjs` | unpacks a job's dataset tar into a folder brush's app takes | by hand |
| `export-world.mjs` | freezes a world into a static folder for `view.html` | by hand (`docs/import.md`) |
| `demo-world.sh` | seeds an operator, land, a second player, credits | by hand |

## infra/, gis/

| path | what |
|---|---|
| `infra/compose.yml` | services `db` (postgis 16-3.4), `postgrest`, `files` (nginx), `geoserver` |
| `infra/nginx.conf` · `infra/postgrest.conf` | file store with `auth_request` to `can_write`; PostgREST on schema `api` |
| `infra/seed/` | `README.md`; `dem-visp.tif`, `osm-visp.gpkg`, `tlm-visp.gpkg`, `worldcover-visp.tif` are written there by the `make-seed-*` tools and gitignored |
| `gis/splatworld.qgs` | not committed: `splatworld qgis` writes it; each player gets their own at `/qgis/project.qgs` |
| `gis/save-ground.py` | QGIS-side script: saves shaped ground as `.r32` + `save_height_edit`, as the player |
| `gis/README.md` | drawing in QGIS |

## docs/ and which file answers what

| question | file |
|---|---|
| how it works, schema, RPCs, atom DAG, verification | `ARCHITECTURE.md` |
| invariants, stack and working rules, gates | `CLAUDE.md` |
| install and first run | `README.md` |
| what the player meets, screen by screen; stories | `docs/SPEC.md` |
| what it looks like | `docs/design/` (`splatworld-v3…v10.dc.html`, `chrome3…8.dc.html`, `flows-servers.md`, `assets/`); `docs/design/README.md` says which artboard is of record for what |
| what is done, in order | `PROGRESS.md` |
| setting up a dev box; traps; conventions | `HANDOFF.md` |
| current work | `PLAYER-RUN.md` → `TASKS-foundation.md` (decisions: `PLAN-foundation.md`) → `TASKS-flows.md` |
| finished plans (TASKS, TASKS-usable, REFACTOR-direct-pg, PLAN-lod) | `docs/history/` |
| running the server: settings, ports, commands | `docs/server.md` |
| running the gates, with or without Docker | `docs/gates.md` |
| GeoServer: what to publish | `docs/geoserver.md` |
| importing a region's layers | `docs/import.md` |
| deploy, operate, feature tour (WP-era) | `docs/manual.md` |
| on call: backup, restore, drift, GC | `docs/runbook.md` |
| Automate, flows, process servers | `docs/flow.md` |
| rendering pipeline, quality vs time, `.r32` | `docs/rendering.md` |
| headset mode | `docs/xr.md` |
| the pilot picture and how to reproduce it | `docs/pilot.md` (+ `pilot.png`) |
