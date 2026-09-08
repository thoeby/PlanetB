# PROGRESS.md — where splatworld stands

Task list: `TASKS.md`. Rules: `CLAUDE.md`. Design: `ARCHITECTURE.md`.
Picking up the work: `HANDOFF.md`.

**WP0 is closed.** `make gate` is green end to end (~2m30s, most of it the
concurrency test). WP1 is under way; see the table below for where.

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

## WP1 — Client core: viewer + streaming

| task | status | commit | file(s) |
|---|---|---|---|
| 1.1 Client scaffold | done | see git log | `client/play.html`, `client/js/{api,auth}.js`, `client/lib/tilemath.js`, `client/test/tilemath.test.js`, `client/test/fixtures/tilemath.json`, `tools/tilemath-fixtures.mjs`, `eslint.config.js`, `package.json` |
| 1.2 Test tiles | done | see git log | `tools/{make-test-tiles.mjs,sogwrite.mjs,test-tiles.sh}`, `db/0009_atomid.sql`, `db/test/0009_atomid.sql` |
| 1.3 Tile streaming | done | see git log | `client/js/{tiles,origin}.js`, `client/play.html`, `client/test/{tiles,origin}.test.js`, `client/test/e2e/`, `playwright.config.js`, `tools/vendor.sh`, `db/0010_lockorder.sql` |

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
22. **The fourth checkpoint differs between the node and browser tests.** The
    node test drives the policy with culling off, so all four z10 leaves stay
    loaded at 2 km; the browser has a real frustum, which at 2 km sees about
    1.6 km of ground and culls most of a 27 km block. Both are asserted.

## WP2–WP5 ⬜

Not started. WP2.8 lists three open decisions in `TASKS.md` that should be
confirmed with the project owner before WP2.8, not silently assumed.
