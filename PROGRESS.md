# PROGRESS.md — where splatworld stands

Task list: `TASKS.md`. Rules: `CLAUDE.md`. Design: `ARCHITECTURE.md`.
Picking up the work: `HANDOFF.md`.

**WP0, WP1 and WP2 are closed.** `make gate` is green end to end, about 8
minutes: the concurrency torture test, the 30 s hot-swap poll and the pilot
compile are most of it. WP3 has not been started.

## WP0 — Foundation ✅

| task | status | commit | file(s) |
|---|---|---|---|
| 0.1 Repo skeleton + tooling | done | `76ace99` | `Makefile`, `infra/compose.yml`, `.env.example` |
| 0.2 Schema migration | done | `a16c86e` | `db/0001_schema.sql`, `db/test/0001_schema.sql` |
| 0.3 Auth + roles | done | `5d0bebe` | `db/0002_auth.sql`, `db/test/0002_auth.sql` |
| 0.4 Row-level security | done | `4b9b29c` | `db/0003_rls.sql`, `db/test/0003_rls.sql` |
| 0.5 Dirty trigger + versioning | done | `61d443e` | `db/0004_tiles.sql`, `db/test/0004_tiles.sql` |
| 0.6 Jobs + atoms state machine | done | `6f581be` | `db/0005_jobs.sql`, `db/0005_state.sql`, `db/test/0005_jobs.sql` |
| 0.7 Concurrency torture test | done | `d0f8309` | `db/test/0006_concurrency.sh` |
| 0.8 Publish + escrow + ledger | done | `16294f8` | `db/0006_publish.sql`, `db/test/0006_publish.sql` |
| 0.9 PostgREST wiring | done | `b290fd7`, `64ed57d` | `db/0007_api.sql`, `infra/postgrest.conf`, `tools/api-test.sh` |
| 0.10 nginx immutable file store | done | `6758928`, `89dca50` | `infra/nginx.conf`, `db/0008_files.sql`, `tools/files-test.sh` |
| 0.11 GeoServer + QGIS admin path | done, **manual gate unticked** | `6eb33ab` | `db/0008_admin.sql`, `infra/geoserver/`, `gis/` |

Gate as of `4b3c9de`: 202 pgTAP assertions, concurrency run (1000 claims,
0 errors, 0 deadlocks), 17 API assertions, 11 file-store assertions, sqlfluff
clean.

### Deviations from TASKS.md, and why

1. **WP0.8 was done before WP0.7.** The torture test hammers `publish_tile`
   with stale versions, so that function had to exist first.
2. **`ensure_job` gained a defaulted 4th argument**, `bounty numeric DEFAULT 0`.
   The ARCHITECTURE §4 signature `ensure_job(z,x,y)` still resolves. Without it
   there is no way to satisfy "caller must own an area … **or attach a
   bounty**", because `set_bounty` needs a job that does not exist yet.
3. **`register()` also creates the user's account row.** `account.owner_id` has
   no other source, and every money path assumes one wallet per user. TASKS.md
   parks this in WP4.4; only the wallet UI is left there.
4. **Ledger and account reads are private** (own wallet only). The deliverable
   constrains writes; reads were unspecified and money is not public.
5. **Two migrations were split for the 400-line limit**: `0005_jobs.sql` +
   `0005_state.sql`, and `0008_files.sql` + `0008_admin.sql`. Both pairs sort
   in dependency order. `0009_spot.sql` (WP3.3) is still free.
6. **`gis/splatworld.qgz` is not committed.** See below.

### Open items from WP0

- [ ] `gis/splatworld.qgz` — QGIS writes this itself; the connection file,
      layers and styles it needs are in the repo. Steps in `gis/README.md`.
- [ ] The WP0.11 manual checklist in `gis/README.md` (QGIS → GeoServer →
      Postgres → PostgREST round trip). Needs a running GeoServer and QGIS.
- [ ] `infra/compose.yml` has never been started — no Docker daemon was
      available. The four services were run individually instead
      (`docs/gates.md`).
- [x] `make lint` runs eslint too, as of WP1.1.

## WP1 — Client core: viewer + streaming ✅

WP1 gate: `client/test/e2e/stream.spec.js` flies z6 → z10 over the test region
in headless chromium and `client/test/e2e/hotswap.spec.js` republishes a loaded
tile and watches it swap. Both run against the real published `.sog` bundles.

| task | status | commit | file(s) |
|---|---|---|---|
| 1.1 Client scaffold | done | see git log | `client/play.html`, `client/js/{api,auth}.js`, `client/lib/tilemath.js`, `client/test/tilemath.test.js`, `client/test/fixtures/tilemath.json`, `tools/tilemath-fixtures.mjs`, `eslint.config.js`, `package.json` |
| 1.2 Test tiles | done | see git log | `tools/{make-test-tiles.mjs,sogwrite.mjs,test-tiles.sh}`, `db/0009_atomid.sql`, `db/test/0009_atomid.sql` |
| 1.3 Tile streaming | done | see git log | `client/js/{tiles,origin}.js`, `client/play.html`, `client/test/{tiles,origin}.test.js`, `client/test/e2e/`, `playwright.config.js`, `tools/vendor.sh`, `db/0010_lockorder.sql` |
| 1.4 Player controller + collision | done | see git log | `client/js/player.js`, `client/test/player.test.js`, `client/test/e2e/walk.spec.js`, `db/0011_tilefiles.sql`, `db/test/0011_tilefiles.sql`, `tools/testterrain.mjs` |
| 1.5 Hot swap | done | see git log | `client/js/tiles.js`, `client/play.html`, `client/test/tiles.test.js`, `client/test/e2e/{hotswap.spec.js,publish.js}` |

The published test tiles are z10 (535,361), (535,362), (536,361), (536,362),
their z8 parents (133,90) and (134,90), and z6 (33,22) — near Aarau,
Switzerland. `bash tools/test-tiles.sh` rebuilds them; `make client-test` runs
it whenever a database is reachable.

**Run `make vendor` once before `make client-test`** or the browser tests skip:
they route the pinned CDN engine URL to `client/vendor/playcanvas/`, which is
gitignored. `tools/vendor.sh` fetches it (CDN, falling back to npm).

| task | notes for whoever picks it up |
|---|---|
| 1.3 Tile streaming | `tile.manifest` carries `origin {lon,lat,h}`; nothing about a tile lives in a file. |
| 1.4 Player controller + collision | needs `height.r16` and `colliders.json`, which `assemble` produces in WP2.3 — use hand-made ones. |
| 1.5 Hot swap | poll `GET /api/tile?...&select=published_version,sog_sha256`. |

### Deviations from TASKS.md, and why

7. **eslint is the repo's first npm dependency** (`package.json`,
   `package-lock.json`, dev only). `CLAUDE.md` bans npm packages *in the
   client* and the client still has none — it is plain ES modules served as
   static files. The Makefile written in WP0.1 already looked for
   `node_modules/eslint`; this is what makes that branch fire. `eslint.config.js`
   itself imports nothing.
8. **`make client-test` was fixed, not just extended.** It ran
   `node --test client/test/`, which node 22 resolves as a module path and not
   as a directory of tests. It now uses the same `client/test/*.test.js` glob
   the guard in front of it already used.
9. **`tile_bbox` north/south are compared within 1e-12°, not bit for bit.**
   glibc and V8 disagree by one ulp on `atan(sinh(x))` — about 1e-14°, under a
   nanometre. West and east are pure arithmetic and *are* compared exactly, as
   are `tile_x`, `tile_y` and all 50 `tiles_for_geom` cases; the acceptance
   criterion is met where it can be. Noted in `client/test/tilemath.test.js`.
10. **WP1.2 had to fix a WP0.6 bug first: `db/0009_atomid.sql`.** `build_dag`
    hashed a merge atom over `{children, snapshot}` and `{voxel, budget}`, none
    of which names the tile. Sibling tiles that see the same features and have
    no published children — every tile of a fresh region — collided on
    `atom_hash`, so the second job was handed the first job's atom and ended up
    with no atoms of its own, unable to publish. The merge atom's params now
    carry `z, x, y`, as the assemble branch always did. `db/test/0009_atomid.sql`
    covers it. This would have blocked WP2.8's 16 z12 children too.
11. **"Uploads via PUT as `admin`" is not a bypass.** `can_write` has no admin
    case, so the tool does the real thing: it claims the tile's `sog` atom and
    uploads to the path that claim reserves. It also produces the merge atom's
    ply and uploads it to `/jobs/{atom}/`, so `atom.output_sha256` points at an
    artifact that actually exists.
12. **The tool needs `cwebp`/`dwebp` (Ubuntu `webp`) on the dev box.** A `.sog`
    is a zip of lossless WebP planes and node has no WebP codec; the in-browser
    encoder is WP2.6's `lib/sogenc.js`. `tools/` is dev-box tooling, so shelling
    out to libwebp is in keeping with `seed-ortho.sh` and friends.
13. **Three files, not one.** `tools/sogwrite.mjs` (the SOG v1 writer and its
    decoder) and `tools/test-tiles.sh` (starts postgrest and nginx if nothing is
    serving, and roots the store at `$FILES_ROOT` so the tiles survive for
    WP1.3) sit next to `tools/make-test-tiles.mjs`, which the 400-line rule
    would not have held on its own.
14. **eslint's function-length rule was set to CLAUDE.md's 60 lines** (it was an
    invented statement count before), which split `mountAuth` in `auth.js`.
15. **`make client-test` now builds the test tiles** when a database is
    reachable, and says so when there is none. WP1.3's playwright tests need
    them served, so the gate has to produce them.
16. **"Refine only if all children published" reads as "all children the world
    says exist".** A child with no `tile` row at all is outside every compiled
    area — the edge of a region, or in the test world the fourteen quadrants of
    a z8 tile nobody has drawn in. Requiring all sixteen would make the test
    region unrefinable and would stop refinement at every area boundary in the
    real one. A child that *has* a row and is unpublished is still a hole and
    still blocks. The consequence is that the streamer is given every tile row,
    not only the published ones.
17. **No CDN is reachable from this sandbox.** The egress proxy refuses
    `code.playcanvas.com`, jsdelivr and unpkg; only `registry.npmjs.org`
    answers. `play.html` still pins the engine from the CDN as `CLAUDE.md`
    requires, `make vendor` (`tools/vendor.sh`) puts a copy in the gitignored
    `client/vendor/playcanvas/`, and the playwright fixture routes the CDN URL
    to it. **The exact CDN URL in `play.html` could not be verified from here**
    — confirm `https://code.playcanvas.com/playcanvas-2.22.0.js` on a networked
    box. Everything else about the engine is verified: the tests run the real
    2.22.0 build.
18. **Browser tests run on WebGL2 over SwiftShader.** `navigator.gpu` has no
    adapter in this container, so the WebGPU path is unexercised here. The
    gsplat pipeline has a GLSL path and renders correctly on WebGL2 — the e2e
    test reads the framebuffer back and checks the splats are actually drawn.
19. **The e2e tests serve the page by route interception, not an HTTP server.**
    `client/` is static files and the file store is a directory of immutable
    blobs; `client/test/e2e/serve.js` reads both off disk and the tile rows
    straight out of the database.
20. **A tile entity gets a rotation as well as a position.** Two ENU frames
    hundreds of kilometres apart are tilted relative to each other, so a z6
    tile placed by translation alone would lean. `enuRotation` and
    `matrixToQuaternion` in `lib/tilemath.js` do it.
21. **WP1.3 fixed a second WP0 bug: `db/0010_lockorder.sql`.** The WP0.7 torture
    test failed about one run in five to one in eight with a `40P01` in an
    editor. Two paths lock more than one `tile` row in a transaction:
    `mark_tiles_dirty` takes every tile a feature touches, coarse-first because
    that is the order `tiles_for_geom` produces; `publish_tile` CASes the child
    and only then dirties its parent, so it runs fine-first. An editor holding
    z12 and waiting on z14, against a worker holding z14 and waiting on z12, is
    a cycle. `publish_tile` now takes the parent's row lock before it touches
    the child, so both paths run coarse to fine, and the upsert states its
    `(z, x, y)` order explicitly instead of relying on `tiles_for_geom`'s.
    Twenty consecutive torture runs at `deadlock_timeout = 200ms` — stricter
    than the 1 s default — came back clean.

    Two wrong turns are worth recording, because the trapped exception is never
    logged and `err_log` says only `40P01 deadlock detected`:

    - Ordering the upsert `(z, x, y)` and stopping there does nothing. The
      inversion is against `publish_tile`, not between editors, and
      `tiles_for_geom` was already producing that order.
    - Ordering it `(z DESC, x, y)` so editors run fine-to-coarse is much worse:
      **110 deadlocks in a single run**. Taking the z6 tile first is what
      serialises the editors against each other — one z6 tile covers everything
      anyone is editing — and reversing the order gives that up.

    The torture test's three-features-per-statement `UPDATE` was suspected and
    is not the cause: its plan is a hash semi-join over a sequential scan, so
    every editor takes those row locks in heap order. `log_lock_waits = on` with
    a short `deadlock_timeout` is how to see the waiting pairs if it returns.
23. **WP1.4 needed a file-store path for terrain: `db/0011_tilefiles.sql`.**
    `can_write` reserved only `.sog` under `/tiles`, so `height.r16` and
    `colliders.json` — which belong to a tile exactly as its splats do — had
    nowhere authorised to go. The rule is otherwise unchanged: only the worker
    holding that tile's `sog` atom may write there, and the declared sha256 must
    still match the filename. WP2.3's `assemble` produces the same two files as
    job artifacts; this is where they land once a tile is published.
24. **The test tiles' hill now varies per tile.** It was a function of `(u, v)`
    and the zoom only, so every tile at a zoom produced byte-identical
    `height.r16` — one artifact, and the store rightly refused the second write.
    The phase now runs on the tile's own coordinates, which also makes the hill
    continuous across tile edges. `tools/testterrain.mjs` holds the ground
    function; the splats, the heightmap and the colliders all read it, so what
    you see is what you walk on. The tool also checks whether an artifact is
    already registered before uploading, which is what a real worker does.
25. **Collisions resolve against the direction of travel, and in substeps.**
    Pushing a circle out along its smallest penetration is wrong as soon as one
    frame's movement lands past the middle of a thin wall — the nearest face is
    then the far one and the player is pushed through. `slide()` takes where the
    player came from and places them against the face they arrived at, and
    `update()` walks the move in pieces no longer than the player is wide, so a
    fast step cannot hop the wall entirely.
26. **The player owns the camera unless a test takes it.** `play.html` exposes
    `setDriving(false)`; the streaming tests use it, and then have to point the
    camera themselves — looking level from 1 000 km up, everything is outside
    the frustum and nothing loads, which is correct and was briefly confusing.
27. **The hot-swap test takes about 90 seconds, on purpose.** WP1.5 asks for
    the swap to land "within 35 s" and the poll runs at its real 30 s interval,
    so the browser test waits for it rather than shortening the timer. That is
    most of the difference between a 3-minute and a 4½-minute `make gate`.
28. **`client/test/e2e/publish.js` publishes over psql, not HTTP.** No API or
    file store is running during the browser tests, so the republish calls
    `ensure_job`, `claim_atom`, `register_artifact`, `submit_atom` and
    `publish_tile` directly with `request.jwt.claims` set — the same functions
    and the same compare-and-swap PostgREST would reach. Only the upload is
    short-circuited: the bytes go straight into the file store, which the page's
    routes read off disk. `tools/files-test.sh` is what covers the PUT path.
29. **Both the tool and the republish helper have to park other jobs' atoms.**
    `claim_atom` picks globally and its `expire_claims()` frees whatever a dead
    worker left behind, so a run can be handed an abandoned atom from an earlier
    `api-test` — including one that was still `claimed` when the run started.
    Anything claimable that is not ours is set to `waiting` for the duration and
    put back afterwards.
22. **The fourth checkpoint differs between the node and browser tests.** The
    node test drives the policy with culling off, so all four z10 leaves stay
    loaded at 2 km; the browser has a real frustum, which at 2 km sees about
    1.6 km of ground and culls most of a 27 km block. Both are asserted.

## WP2 — Atoms without training ✅

A browser tab now compiles the world. Real terrain and imagery are seeded into
the file store, real OSM features into the database, and one tab turns them into
published tiles: assemble, sample, encode, upload, publish, then merge upwards.
`docs/pilot.md` has the picture and how to draw it again.

| task | status | commit | file(s) |
|---|---|---|---|
| 2.1 Geo input seeding | done | `df7e694` | `tools/{geo-common,seed-dem,seed-ortho,seed-osm,seed-test}.sh`, `tools/osm-flex.lua`, `infra/seed/` |
| 2.2 Worker runtime | done | `bcd51a6` | `client/js/{work,inputs,atomworker,workui}.js`, `client/lib/hash.js`, `client/atoms/noop.js`, `db/0012_work.sql` |
| 2.3 `assemble-v1` | done | `39416b0` | `client/atoms/assemble.js`, `client/lib/{ply,tar,geo,poly,mesh,terrain,props}.js`, `db/0013_world.sql` |
| 2.4 `frame-v1` | done | `9cce90d` | `client/atoms/frame.js`, `client/lib/{cameras,render}.js` |
| 2.5 `merge-v1` | done | `8d5ed5d` | `client/atoms/merge.js`, `client/lib/sogenc.js`, `db/0014_childsogs.sql` |
| 2.6 `sog-v1` | done | `81614ee` | `client/atoms/sog.js`, `client/lib/sogenc.js` |
| 2.7 Structural checks live | done | `1d81dcd` | `db/0015_structural.sql` |
| 2.8 End-to-end | done | `8c974f2` | `client/atoms/sample.js`, `db/0016_sample.sql`, `client/test/e2e/pilot*.spec.js`, `docs/pilot.{md,png}` |

Gate as of `8c974f2`: 243 pgTAP assertions over 12 files, the concurrency run,
43 API and file-store assertions, 69 node assertions, 22 test-tile assertions
and 14 headless-chromium tests. About 8 minutes.

### Two bugs this work package found in earlier ones

- **`child_sogs()` never found a child** (`db/0014_childsogs.sql`). Its
  parameters are named `z`, `x`, `y` and its body compares them against a
  `tile t` in the same scope, so `t.z = z + 2` was `t.z = t.z + 2`. Every merge
  atom in the system named sixteen empty children. This is the same trap that
  cost WP0.6 the merge atom's identity (`db/0009_atomid.sql`) and is the one
  `HANDOFF.md` warns about; it is worth grepping for again whenever a SQL
  function's parameter shares a name with a column.
- **The file store outlives the database.** A second `make gate` on the same box
  hit nginx's 409 on paths a previous run had written and the artifact table no
  longer knew about. `make-test-tiles` now accepts a 409 whose bytes hash to
  what it was uploading, and `test-tiles.sh` drops `/jobs` directories no atom
  owns any more.

### Deviations from TASKS.md, and why

30. **swisstopo and Geofabrik are unreachable from this sandbox; AWS open data
    is.** The DEM falls back to Copernicus GLO-30 (30 m, not swissALTI3D's 2 m)
    and the ortho to Sentinel-2 L2A true colour (10 m, not swissimage's 2 m).
    Both are real data for the real pilot region. The OSM path has only been run
    against `infra/seed/pilot-fixture.osm`, a hand-made extract holding one of
    everything the style maps — `OSM_FILE` takes a real Geofabrik extract on a
    networked box.
31. **z16/z18 are seeded for one z16 tile at the pilot's centre**, not for the
    whole z10 tile: 4096 z18 tiles for one pilot is not what WP3 needs.
32. **The browser tests that write need real services and a secure context.**
    `client/test/e2e/services.js` starts postgrest, nginx and a static server on
    localhost, and only the engine CDN is intercepted. WebCrypto and the Cache
    API do not exist otherwise.
33. **nginx answers CORS on `/assets /tiles /jobs /geo`**, including the
    preflight a PUT with `Authorization` and `X-Sha256` needs. A worker tab is
    served from a different origin than the store; without it no browser could
    upload at all. The token still decides every write.
34. **`assemble` builds its own geometry and writes `scene.json` + `mesh.bin`;
    it does not instantiate a PlayCanvas scene**, and `frame` renders with a
    small WebGL2 forward renderer rather than the engine. Nothing in `assemble`
    renders, and the scene is our own vertex colours with one light.
35. **Roofs are built on the footprint's oriented bounding box**, holes in a
    ring are not triangulated, and trees are cone-and-trunk proxies until WP4.1
    gives the catalog real GLBs.
36. **`assemble` clips its scene to the tile** (whole triangles, 8 m margin). A
    road arrives whole and runs for kilometres; a tile shows its own ground.
37. **An atom records where its output went** (`result.path`), because an
    artifact is written once and an atom that recomputes another's bytes cannot
    put them under its own job directory.
38. **A canvas stores colour premultiplied by alpha**, so `sog-v1` keeps every
    plane's alpha byte high — 255 where the format leaves it free, and sh0's
    opacity remapped into the top half of its range. That costs one bit of
    opacity and keeps colour exact to a count; the bundle is still an ordinary
    SOG v1 and PlayCanvas reads it in the gate. Reading a plane back uses WebGL,
    which can be told not to premultiply.
39. **A sog's bytes are deterministic for a browser build, not across engines**:
    the WebP encoder is the platform's. `merge` and `sample`, which are
    arithmetic, are deterministic everywhere. WP2.7's hash check is what would
    notice a heterogeneous fleet, and it would blame the workers.
40. **A hash disagreement is read as "neither answer is trusted"**: the output
    is discarded, both workers are marked bad and the atom is offered again,
    failing for good on the third attempt. Marking it failed on the first
    disagreement would brick a tile at that version for ever.
41. **`recheck_atom()` is new API surface**, without which the hash comparison
    is unreachable: a verified atom cannot be claimed.
42. **The merge is CPU-only.** "Byte-identical on two different GPUs" is met by
    not using one, and `params.voxel` (0.05 m) is a floor: the effective voxel
    is the parent's own sample spacing, `edge / sqrt(budget)`.
43. **A missing child is recorded and skipped**, not replaced by parent-level
    assemble samples: that fallback needs an atom the merge DAG does not build.
44. **The pilot gate compiles one z14 tile and its ancestors**, not all 256.
    `PILOT_BLOCK=1 npx playwright test client/test/e2e/pilot-block.spec.js`
    compiles a whole z12 block, which is what drew `docs/pilot.png`.
45. **TASKS.md's three open decisions were taken as written**, not put to the
    project owner: `sample-v1` for the z14 baseline, 20 frames to a frame atom,
    and `can_write` trusting the declared sha at upload. They are stated as
    decisions in TASKS.md; the first is now in ARCHITECTURE.md too.
46. **WP1's browser tests are given exactly the seven tiles WP1 publishes.**
    They assert exact sets of loaded tiles, and the world now holds compiled
    pilot tiles as well.

## WP3–WP5 ⬜

Not started.

### What WP3 inherits

- **The worker loop is done and tested.** `client/js/work.js` claims, fetches,
  runs an atom in a Web Worker, uploads, registers, submits and publishes.
  `train` needs an `atoms/train.js` and nothing else from the runtime.
- **`assemble` already emits what `train` starts from**: `init.ply` at 30 % of
  the budget, inside the tar, with `scene.json` and `mesh.bin` beside it.
- **`frame` already renders the camera sets** and writes nerfstudio's
  `transforms.json` in OpenGL's convention, chunked 20 views to an atom.
- **`verify` has its numbers**: `client/lib/render.js` has `psnr()` and the
  renderer that produced the reference frames.
- **`recheck_atom()` is the lever WP3.3's spot-check pulls.**
- **No GPU here.** `navigator.gpu` has no adapter in this container, so the
  WebGPU path — which `train` needs — is untested. WP3 wants a real GPU.

