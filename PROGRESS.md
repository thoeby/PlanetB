# PROGRESS.md — where splatworld stands

Task list: **`PLAYER-RUN.md`** — the stories of `docs/SPEC.md` §3, each proven
by a script that behaves like a player, in one run from an empty database.
`TASKS.md` and `TASKS-usable.md` are history. Rules: `CLAUDE.md`. Design:
`ARCHITECTURE.md`. Picking up the work: `HANDOFF.md`.

## The player-run

`make player-run` — `client/test/run/`, a Playwright project of its own. It
resets the database, empties the file store, starts the server and a GeoServer
over a 4 x 4 km DEM cutout of Visp (`tools/make-seed-dem.sh`), and hands the
stories browser contexts that have only the page.

| story | what it proves | state |
|---|---|---|
| 1 | first run (§3.1): sign up, name, GeoServer, coverage, standing on the DEM, walking fifty metres | green |
| 2 | getting land (§3.2): request, admin draws it on the map, notified, Go, boundary and name on the ground; swapped coordinates refused | green |
| 3 | shaping land in QGIS (§3.3): the project from the Land panel, a real headless QGIS drawing a wood and a tree over a direct connection as the player, the page saying so within half a minute; drawing off your land refused in words | green |
| 4 | registering a product (§3.9): a GLB dropped in, its size shown, named, registered, and found in the picker by name — the only story so far that needed nothing built | green |
| 5 | building (§3.4): build mode on your own land, a product picked, placed, moved and saved; a second player sees the models marked "not yet rendered"; undo and save again and they see one; off your land the control says whose it is | green |
| 6–13 | | not started |

What each story forced is in its commit message. Nothing is "done" here
because a function exists: if the script cannot find the button, the button is
missing.

**WP0 through WP5 are closed.** `make gate` is green end to end, about twenty
minutes: the concurrency torture test, the edition race, the restore drill, the
30 s hot-swap poll, the pilot compile and WP3's trained tile are most of it.

Two acceptances are unrun for want of hardware and are marked as such: WP3.1's
"a pilot z16 tile in under 8 minutes" (no GPU here) and WP5.4's XR mode (no
headset). WP5.1's raster seed has been run over a region, not over the whole of
Switzerland — the sources for that are outside this container's egress policy.

## The interface, against the design ✅

`docs/SPEC.md` is the product specification and `docs/design/` the design it
serves — eleven artboards at 1920 × 1080 plus the chrome they all import. Both
are now in the repo; `docs/design/README.md` maps each part of the design to
the file that holds it.

The panels were already here and already in the design's language. What the
design had and the build did not:

| design | what was done |
|---|---|
| five-stage pipeline, credits apart | `#pipeline` + `#credits` replace the three stat cards (`client/js/hud.js`, `hud.css`) |
| hotbar in four named groups, a number key on every tab | `GROUPS`, `TABS.key`, `bindKeys` — 1–0 and `` ` `` open a panel, Escape closes it |
| a map in the corner | `client/js/hudmap.js`, drawn from the same outlines the Your land panel lists |
| a panel as wide as what it shows | `TABS.width`, set on `#panel` when a tab opens |
| the controls line and the legend in full | Run and Close panel; "No build rights" |
| nothing over the crosshair | the empty-world notice moved above the hotbar |
| Rajdhani, Sora, JetBrains Mono | `tools/vendor.sh` fetches all three from @fontsource; they were referenced by `hud.css` and never vendored, so the page had been running on the fallback stack |

Two things this build does that neither document does, kept as they are: a
rendered tile is a **candidate** a person approves (the spec approves before
rendering), and land is drawn in QGIS rather than assigned by an admin.

### What this container cannot run

`make db-test` (614 assertions, the concurrency run and the edition race),
`make api-test`, the node suite (189 assertions) and `make lint` are green.
Eleven browser tests are not, and **none of them is the interface**: they are
the ones that compile something (assemble, merge, sog, train, catalog's
canonicalise, background, spot) plus `stream.spec`'s five checkpoints. Checked
against a worktree of this same commit with none of the interface work in it:
`merge.spec` and `stream.spec:106` fail there identically, on the same atoms
and the same tile sets. This box is slower than the one they were written on —
an assemble atom is still `claimed` when a 150 s poll gives up, and at 5 000 km
the streamer still has the z6 tile where the test wants its two z8 parents. The
33 that pass include all four of `hud.spec`.

`make api-test` also fails about one run in two when it follows `db-test` in
the same `make gate`: the concurrency test leaves 3 360 ready atoms behind and
`claim_atom` picks globally, so "the claimed atom is the assemble" is handed
somebody else's `sample`. It passes on its own. That is the trap `HANDOFF.md`
already warns about, now with a name.

### Two bugs this found

- **No browser test had ever seen the stylesheet.** `client/test/e2e/serve.js`
  and `services.js` served `.css` as `application/octet-stream`, which a
  browser refuses to apply — the page then renders complete, correct and
  entirely unstyled, and every assertion about text still passes.
  `client/test/e2e/hud.spec.js` now asserts that a rule actually applies, which
  is the assertion that would have caught it.
- **`tools/files-test.sh` asserted a rule `db/0051_sharedbytes.sql` had
  deliberately abandoned** ("PUT of an already registered sha is 403"). That
  migration allows the same bytes at a second content-addressed path and keeps
  the refusal for `/jobs/`; the test now says that, and says why.

## What is actually done against the spec and the design

`docs/SPEC.md` names eleven surfaces; `docs/design/` draws them. This is where
each one stands, honestly, so nobody has to guess from a commit list.

| surface | chrome | interior |
|---|---|---|
| World | done | **done** — the next-step card (`client/js/nextstep.js`) says which of the four steps your land is on and opens the panel for it |
| Your land | done | **done** — rows, counts, approvals stepper, people, proposals, drawn kinds, contents |
| Place | done | **done** — build-mode switch, pick, selected, Move/Turn/Size, axis, step, snap, delete/undo |
| Catalog | done | **done** — find, a grid of cards, Register as three numbered steps |
| Submit | done | **done** — which land, the four tile counts, price presets, what the pool pays, the total and the balance after |
| Render pool | done | **done** — This machine (caps and the two switches), the queue sorted by distance or pay, render and try-again |
| Permission | done | **done** — the before/with row-switch, what is waiting, approve or refuse with a note |
| Wallet | done | **done** — the four totals, All/Paid/Earned, the movements, the bounty card |
| Share | done | **done** — the link, and the four facts about what whoever opens it will find |
| Admin | done | **done** — Kinds and Rules, each with the artboard's heading, lede and rows |
| Setup | done | **done** — the three numbered steps, in order, with the one to do next marked |

"Chrome" is the frame: the hotbar, the five-stage pipeline, the map, the panel
docking, the type and colour. "Interior" is what the artboard shows inside the
panel, which is where the features are. All eleven are built; every one
of them was opened in a browser against a seeded world (`tools/demo-world.sh`)
with no page errors.

### Bugs found and fixed while doing it

- **Drawing land in QGIS was refused** (`db/0057`). `gis.area` was a plain view
  over a Polygon column and QGIS sends a multipolygon of one part, so no land
  saved and every feature drawn afterwards failed with "nothing here belongs to
  an area yet" — which is the error that reached the drawer. Third time round
  this loop; the reasoning is in the migration so it is not reverted a fourth.
- **What you draw belonged to the wrong account** (`db/0058`). `gis.default_owner()`
  answered "the oldest admin", which on any world with a second admin — a seed,
  a test fixture, a colleague — is not the operator. Land was saved, silently,
  to somebody else, and Your land was empty. It is `ground.set_by` now: the
  account that set this world's ground. Setup says which account that is, so it
  can never be silent again.
- **The Your land panel ignored everything drawn in QGIS** (`db/0059`).
  `area_contents` lists placed products only, so a world with a lake and a wood
  in it answered "nothing stands on it yet".
- **The setup probe passed while every Save failed.** It drew a single POLYGON
  on two layers out of seven. It now draws on every drawable kind, read from
  the `kind` table, multi-part, with required properties filled — which
  immediately found a terrainmod refused for a blank `op`.
- **`make db-test` was red** before any of this: `db/test/0029_qgis.sql` died at
  its seventh assertion on a pgTAP record comparison. 635 assertions green now.
- **No browser test had ever seen the stylesheet**: both test servers served
  `.css` as `application/octet-stream`, which a browser refuses, and an
  unstyled page passes every assertion about text.
- **The fonts were never vendored.** `hud.css` has @font-face'd Rajdhani, Sora
  and JetBrains Mono since it was written; `make vendor` now fetches them.
- **The Render pool said everything twice.** The old work panel and the new
  one were both mounted in that tab, so the machine's capabilities, the
  background switch and "help render the world" each appeared twice, in two
  different styles. `workui.js` is the design's "This machine" section now and
  the queue below it is the only other thing in the panel.
- **The catalog's cards were three times too big.** A leftover `#panel #results`
  rule outranked the `.cards` grid by id, so the grid the design draws was
  never the one in force.
- **The switches were bare grey boxes.** `.switch` and `.row-switch` were used
  by three panels and styled by none; a checkbox in a switch row is drawn as
  the switch now, so the two kinds of control look like one kind of thing.
- **Setup asked for an account last.** Step 1 is the account, and the sign-in
  form was mounted under steps 2 and 3 — so the panel read 2, 3, 1. The form
  goes in step 1's slot, and the step to do next is marked from the session.
- **The chrome's credits said "—" until you signed in through the form.** The
  wallet tells the chrome what it learned, on every refresh.
- **`make lint` was red** on 47 sqlfluff findings and **`make api-test` had a
  failing assertion**, both before this round: the api test claimed the
  best-ranked atom in the whole database and expected it to be the one it had
  just opened, which it is only on an empty world. It claims from its own job
  (`claim_for`) now.
- **The browser suite went from 23 passed / 13 failed in 26.6 minutes to
  42 passed / 2 failed in 9.** What the thirteen actually were: one product
  bug (a tab that offered to help render the world claimed nothing at all
  below 30 fps — the pace stood aside for ever), a file store nginx could not
  write into, three of my own dropped selectors, three fixtures that asked
  for a tile version the world had moved past, a spec polling for a state the
  world passes straight through, a quality assertion that needs a GPU, and an
  assertion about OSM data this container has never had. Each is fixed where
  it was, or says plainly what it needs. The last two are order-dependence
  between the specs that compile and the specs that look, written up in
  HANDOFF §1.
- **`tools/demo-world.sh` is new**: an operator, a ground, a piece of land with
  three things drawn on it, a second player with a grant, and 250 credits — so
  the panels have something to show and the browser can be pointed at it.

### The CRS rework: checked, and now held to it

It landed and it is coherent. `world_srid()` and `tile_srid()` are the only
places an EPSG code is chosen in SQL, `crs.py` and `lib/crs.js` are the same
for Python and JavaScript, and guards keep Python and JS from spelling one out.
Two holes, now closed by `server/test_crs_agree.py`:

- **SQL was unguarded.** A migration could pass 4326 to PostGIS by hand and
  nothing noticed. Geometry typmods are stripped first — `geometry(Polygon,
  4326)` is a declaration, not a choice — and any bare SRID left in a migration
  after `db/0056` now fails the test.
- **Twelve function bodies still spelled 4326 out** (`db/0060`). The codes were
  in one place *and* in twelve others, which is not one place. Every one of them
  is redefined through `world_srid()`, and the test now reads the applied
  catalog rather than the files: no function body in the world that runs may
  name a code. What is left written out is fixed when the DDL runs and cannot
  call anything — the generated `geom` column in 0001, the CHECK in 0029, the
  typmods, and 0053's one-time UPDATE.
- **Nothing checked the copies agree.** `tile_bbox_merc()` in SQL and
  `crs.tile_bounds()` in Python are compared over five tiles from z0 to z18,
  to six decimal places, along with the pair of SRIDs they name. They agree
  exactly today; now they have to.

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
   in dependency order. WP3.3's spot-check migration is `0018_spot.sql`
   (`0009`–`0017` are taken).
6. **`gis/splatworld.qgz` is not committed.** See below.

### Open items from WP0

- [ ] `gis/splatworld.qgz` — QGIS writes this itself; the connection file,
      layers and styles it needs are in the repo. Steps in `gis/README.md`.
- [ ] The WP0.11 manual checklist in `gis/README.md` (QGIS → GeoServer →
      Postgres → PostgREST round trip). Needs a running GeoServer and QGIS.
- [ ] `infra/compose.yml` has never been started — no Docker daemon was
      available, in the close-out review either. The four services were run
      individually instead (`docs/gates.md`). The file passes
      `docker compose config`; its relative volume paths were wrong until the
      review fixed them (see `docs/manual.md`).
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

## WP3 — Training + perceptual verification ✅

A tile is now learned rather than sampled. One tab claims a `train` atom, runs
Adam over a differentiable gaussian rasteriser in WebGPU until the tile
reproduces the frames `frame-v1` rendered of it, and encodes the result; three
other tabs download the .sog, render two poses the trainer was never shown, and
the third agreement is what publishes the tile. After that, every owner's tab
that walks past checks it again for free.

| task | status | commit | file(s) |
|---|---|---|---|
| 3.1 Trainer + `train-v1` | done | see git log | `client/lib/{gsmath,gsrast,gsgrad,gsmodel,gsopt,gstrain,gsgpu,gswgsl,gswgslgrad,frames}.js`, `client/atoms/train.js`, `client/test/{gsgrad,gstrain,frames,scene}.js`, `client/test/e2e/gsgpu.spec.js` |
| 3.2 `verify-v1` | done | see git log | `client/atoms/verify.js`, `db/0017_verify.sql`, `db/0017_verifydag.sql`, `db/test/0017_verify.sql`, `client/test/e2e/train.spec.js` |
| 3.3 Owner spot-check | done | see git log | `db/0018_spot.sql`, `client/js/spot.js`, `client/play.html`, `client/test/spot.test.js`, `client/test/e2e/spot.spec.js` |
| 3.4 Trust | done | see git log | `db/0019_trust.sql`, `db/test/0019_trust.sql` |

Gate at the end of WP3: 284 pgTAP assertions over 14 files, the concurrency run,
43 API and file-store assertions, 85 node assertions, 22 test-tile assertions
and 20 headless-chromium tests. About eleven minutes; `train.spec` is a minute
of it, and the pilot compile and the hot-swap poll most of the rest.

### The trainer, in one paragraph

`client/lib/gsrast.js` is the renderer — project each gaussian with the EWA
approximation, bucket it into the 16x16 tiles it touches, sort each bucket by
depth and composite front to back — and `client/lib/gsgrad.js` is its
derivative, checked against finite differences in `client/test/gsgrad.test.js`.
`client/lib/gswgsl.js` and `client/lib/gswgslgrad.js` are the same arithmetic in
WGSL, and `client/test/e2e/gsgpu.spec.js` renders one scene through both and
compares them, then compares where one step of Adam leaves every parameter.
`client/lib/gstrain.js` is the loop, `client/lib/gsopt.js` the Adam and the
population control, and `client/atoms/train.js` the atom. The CPU path is not a
toy: it is what `verify` renders with, and what the node tests train with.

### Deviations from TASKS.md, and why

47. **Splat.js could not be vendored, because there is no such thing.** npm has
    a dozen gaussian-splat *viewers* and no browser trainer (`splat`,
    `gaussian splatting`, `3dgs`, `splatjs` were all searched), and the sandbox
    reaches `registry.npmjs.org` and `raw.githubusercontent.com` and nothing
    else. `train-v1` is therefore ours, written against the published 3DGS and
    3DGS-MCMC formulations. There is no `client/vendor/splatjs/`, no
    `vendor/splatjs.patch` and no new dependency; `CLAUDE.md`'s rule about
    asking before adding one is met by not adding one.
48. **The trained artifact is a float32 ply inside a tar, not a bare fp16 ply.**
    `client/lib/ply.js` defines the format the rest of the pipeline reads and it
    is float32; a half-float variant needs a second reader and buys nothing,
    because `sog-v1` quantises to 8 and 16 bits immediately afterwards. The tar
    carries `height.r16` and `colliders.json` through from `assemble` exactly as
    `sample-v1` does, so a trained tile is as walkable as a baseline one.
49. **Training and verification run at 512 px, not the frames' 1024.**
    `client/lib/frames.js` box-filters a frame down on the way in — a quarter of
    the memory over 120 views, and, more to the point, the same picture for the
    trainer and for the verifier. `frame-v1` also grew an optional `size`
    parameter; nothing in the DAG sets it and the store still holds 1024 px
    frames, but the browser gate renders smaller ones.
50. **Four poses per camera set are held back from training.** `holdout()` picks
    them, `train` reports its PSNR on those and no others, and the three verify
    atoms take two each, so between them they cover all four. A trainer that
    overfits its own views therefore fails, which is the whole point of asking
    somebody else.
51. **The loss is 0.8 x L1 + 0.2 x L2, not the paper's D-SSIM.** A windowed
    statistic has to be carried through the shader as well, and the second term
    is there to punish the big misses harder than the small ones, which L2 does.
52. **A verified .sog publishes its tile inside `submit_verification`.**
    ARCHITECTURE said "publish_tile by the sog worker after verified". That
    worker is minutes gone by the time the third verifier answers, and a tile
    that waits for a tab to come back is a tile that never publishes.
    `publish_sog()` is the same compare-and-swap (Invariant 3), attributed to
    the .sog's own worker, and `publish_tile` now goes through it too.
53. **A perceptual rejection retrains; the third one fails the tile.** TASKS.md
    says one fail → `failed`, which bricks a tile at that version on a single
    bad opinion. The codebase already had the answer to that (deviation 40): the
    trainer is blamed, the train atom goes back to the pool with its output
    cleared, and the third rejection fails it for good.
54. **A verify atom writes no artifact.** `artifact.kind` has no `verify` and
    adding one means altering a table that already has a migration. The answer
    *is* the result, and `submit_atom` forwards it to `submit_verification`
    server-side — which is the only place the "three distinct workers, none of
    them the trainer" rule can actually be enforced (Invariant 6).
55. **A failed spot check on an already-published tile marks it `suspect` and
    stops there.** TASKS.md asks for the job to be re-opened as well.
    `publish_tile` is a compare-and-swap against `expected_version`
    (Invariant 3), so a second run at the same version could never publish, and
    re-opening the job would only look like progress. Recompiling a suspect tile
    needs an atom identity that includes the job's target version — an atom
    belongs to one job, so a rebuild at a new version currently reuses atoms
    that belong to the old one (the trap of deviation 10). That is a WP4 change
    and is listed under "open items" below.
56. **Trust needed a way up that does not already require being trusted.** A new
    worker starts at 0.5, judging somebody else's tile needs 0.6, and the only
    rewards TASKS.md names are for having your own tile judged — which needs a
    judge. An accepted atom is therefore worth +0.01, five times less than a
    perceptual pass and twenty times less than a rejection costs, purely so the
    circle opens: about ten accepted atoms earns a tab the right to an opinion.
57. **WP3.1's acceptance is unrun.** There is no hardware adapter here.
    `--enable-unsafe-webgpu` gives real WebGPU over SwiftShader, which is enough
    to check the shader against the JS reference and to train a small tile, and
    nothing like enough for "a pilot z16 tile in under 8 minutes, PSNR >= 24".
    `client/test/e2e/train.spec.js` trains a real z16 tile of the pilot at
    20 000 splats, 40 iterations and 96 px instead, and asserts that training
    improved the held-out PSNR rather than that it reached a number.
    **Run WP3.1's acceptance on a box with a GPU.**
58. **The heartbeat rides on the atom's own progress reports as well as on a
    timer.** A worker saturating four cores starves its main thread and
    `setInterval` stops arriving: the first z16 training run here lost its claim
    to `expire_claims` twice while it was still working. `WorkLoop` now beats
    when an atom logs, if the last beat is older than half the interval. On a
    machine with a GPU the CPU is idle during training and this never fires.
59. **The spot checker stands aside while the tab is working** and does not
    sweep on load. A check costs about what rendering a frame does; it is a
    courtesy, not a duty, and it must never compete with an atom the tab has
    already claimed.

### Two things this work package found in the environment

- **The pilot DEM and ortho had never been seeded here.** `tools/seed-test.sh`
  cuts *one* z14 tile to prove the path works, and the pilot specs skipped only
  when `geo/dem` did not exist at all — so they ran, and failed three minutes
  later with "no dem covers 16/34231/22946". `bash tools/seed-dem.sh` and
  `bash tools/seed-ortho.sh` cut the real 290 tiles each (about four minutes
  over AWS open data), and `demSeeded()` in `client/test/e2e/serve.js` now walks
  the same ancestor fallback `client/lib/geo.js` does, so the skip is honest.
- **The per-tile bitonic sort ran its whole network whatever the tile held.**
  1024-entry capacity, 55 stages, every tile, every iteration — about four
  seconds an iteration on a real tile. Sizing the network to the next power of
  two at or above what the tile actually holds is most of the difference between
  that and the 0.8 s the gate now takes.

  Sizing it needed a second fix. A `workgroupBarrier` may not sit in control
  flow that depends on a value read from a storage buffer, and a tile's splat
  count is exactly that: WGSL rejected the shader. `workgroupUniformLoad` is
  what makes such a value uniform — thread zero works the size out, and the load
  barriers and hands back something the compiler knows every thread agrees on.

- **A WGSL shader that does not compile says nothing.** The pipeline is invalid,
  its dispatches are dropped, and the buffer it should have written comes back
  full of zeros — so the trainer trained happily against black images and
  reported a PSNR that never moved. `gpuBackend()` now asks every module for its
  `getCompilationInfo()` and throws on the first error, which is the only reason
  the next one of these will take a minute instead of an afternoon.

### Open items from WP3

- [ ] **WP3.1's acceptance on a GPU**: a pilot z16 tile in under 8 minutes at
      600 000 splats / 5 000 iterations, PSNR >= 24 against the four held-out
      frames. Everything is in place to run it; nothing here can.
- [ ] **A tile's per-tile splat list is capped at 1024** (`CAPACITY` in
      `client/lib/gsgpu.js`), which is the largest bitonic sort that fits in
      16 KB of workgroup memory. A denser tile silently drops whichever splats
      lose the atomic race. At 512 px and 600 000 splats the average tile holds
      about 600, so this bites only in the densest corners; sorting in global
      memory would lift it.
- [ ] **Recompiling a `suspect` tile** (deviation 55).

## WP4 — Catalog, building, areas, money ✅

The world can be walked and compiled; WP4 is what people put in it. 4.1 gives
an uploaded model one identity however it was exported — a trained tile and a
sampled one are the same tile to the catalog, and to the ledger that pays for
either.

| task | status | commit | file(s) |
|---|---|---|---|
| 4.1 Canonical GLB + SAN | done | see git log | `client/lib/{canon,canonmesh,canontex,glb,png,draco,thumb}.js`, `client/js/{catalog,catalogui}.js`, `client/catalog.html`, `db/0020_assets.sql`, `db/test/0020_assets.sql`, `client/test/{canon,draco}.test.js`, `client/test/e2e/catalog.spec.js`, `tools/make-asset-fixtures.mjs` |
| 4.2 Build mode | done | see git log | `client/js/{build,buildui,preview}.js`, `client/lib/glbmesh.js`, `client/atoms/assemble.js`, `client/play.html`, `db/0021_build.sql`, `db/test/0021_build.sql`, `client/test/build.test.js`, `client/test/e2e/build.spec.js` |
| 4.3 Areas, grants, proposals | done | see git log | `db/0022_proposals.sql`, `db/test/0022_proposals.sql`, `client/js/{areas,areasui,buildui}.js`, `client/play.html`, `client/test/e2e/areas.spec.js` |
| 4.4 Money | done | see git log | `db/0023_money.sql`, `db/test/0023_money.sql`, `db/test/0023_buy.sh`, `client/js/{wallet,walletui,catalogui,buildui}.js`, `client/play.html`, `client/test/e2e/money.spec.js` |

Gate at the end of WP4: 407 pgTAP assertions over 18 files, the concurrency run
and the buy race, 47 API and file-store assertions, 108 node assertions, 22
test-tile assertions and 31 headless-chromium tests. About twelve minutes.

### Deviations from TASKS.md, and why

60. **WP4.1 was written beside WP3, not after it.** This container has no GPU
    adapter, so WP3 could not start here and the project owner asked for WP4;
    WP3 landed on the branch meanwhile, from a box that had one. WP4.1 was
    rebased onto it and its migration renumbered to `db/0020_assets.sql`.
    Nothing in the two touches the same table, function or file.
61. **`asset` gained a nullable `thumb_sha256`** (`db/0020_assets.sql`).
    ARCHITECTURE §7 already reserves `/assets/{sha}.webp` for thumbnails and
    WP4.1 renders one, but no column pointed at it. Additive, and
    `api.asset` is `CREATE OR REPLACE`d so PostgREST serves the new column.
    This is one of the "ask first" cases in CLAUDE.md; it was asked and agreed.
62. **canon-v1 drops vertex colours.** `COLOR_0` is the attribute exporters
    disagree about most — present or absent, float or normalised byte, linear or
    sRGB — and colour already lives in the material. Keeping it would have made
    the SAN depend on which exporter wrote the file, which is the one thing
    canon-v1 exists to prevent.
63. **canon-v1 drops `magFilter`/`minFilter` too.** They are a preference about
    how to sample a texture, not part of the asset; Blender writes them and the
    CAD fixture does not. `wrapS`/`wrapT` are kept, because they change which
    pixel a UV outside 0..1 reads.
64. **A texture within budget keeps its exact bytes.** Only an image over
    2048 px is decoded, box-filtered and re-encoded. Re-encoding every texture
    would need a deterministic encoder for JPEG and WebP as well, and an asset
    whose pixels differ *is* a different asset.
65. **The one image canon-v1 writes is PNG from `client/lib/png.js`**, deflated
    as stored blocks. A canvas encoder is the platform's (deviation 39) and a
    SAN that changed with the browser would fracture the catalog. Stored blocks
    mean no compression, which is the price of having no choices to disagree
    about. Decoding uses `DecompressionStream`, which node and browsers share.
66. **Draco is decoded through the vendored Google decoder**, injected as
    `decodeDraco` rather than imported: a page without it refuses the upload
    instead of producing a second, wrong canonical form. `make vendor` now
    fetches `draco3d` (Apache-2.0) alongside the engine, and
    `client/test/draco.test.js` compresses the bench with the matching encoder
    and checks the round trip lands on the same SAN. It skips without
    `make vendor`.
67. **`similar_assets` is an RPC, not a client-side scan.** The near-duplicate
    check needs every asset's bbox and triangle count; doing it in SQL keeps
    the page from downloading the catalog to answer one question.
68. **A thumbnail is shared between assets that look alike.** `lib/thumb.js`
    renders with `frame`'s vertex-colour renderer, which has no textures, so two
    assets with the same geometry and material colours produce the same WebP and
    therefore the same artifact. That is content addressing working, but it
    means an upload routinely gets a 409 for a thumbnail somebody else already
    wrote — and after a `make db-reset` the store still holds bytes the
    `artifact` table has forgotten. `catalog.js` registers on 409 as well as on
    201 because of it, and only a 403 (which `can_write` raises when the sha is
    already an artifact) means there is nothing left to do. This is the same
    trap WP2 hit with `/jobs`; it found this bug in the gate.
69. **`lib/hash.js` still hashes in one shot, not streaming.** WP4.1's
    deliverable asks for a streaming sha256; `SubtleCrypto.digest` has no
    streaming form in any browser, and hand-writing SHA-256 to get one would be
    slower than the platform's and would duplicate what WP2.2 already ships and
    every atom already uses. A canonical GLB is bounded by the 2048 px texture
    rule, so one-shot is what it gets.
70. **WP3's test cleanup had to learn about the new column.** `resetJob` in
    `client/test/e2e/worker.js` deletes every artifact nobody points at, and it
    enumerates the references by hand; `asset.thumb_sha256` is a new one, so
    two WP3 browser tests failed on the foreign key the moment the two work
    packages met. Anything that adds a reference to `artifact` has to be added
    there too.
71. **`tools/seed-dem.sh` and `tools/seed-ortho.sh` now register tiles that are
    already on disk.** A run interrupted before `geo_register` left 290 files in
    the store and nothing in `artifact`, and every later run skipped them as
    "already present" — so the store and the database could never converge
    again. `register_artifact` is idempotent, so the skip path now registers
    too. This is the same class of bug as the `/jobs` 409 in WP2.

72. **`assemble` now places catalog GLBs, which WP4.2 did not ask for.**
    ARCHITECTURE §5 always listed GLB hashes among an assemble atom's inputs and
    §6 lists "GLB placement" in `assemble-v1`; until WP4.1 there were no GLBs to
    place, so it was never written. Without it "place → render → new version
    visible" would publish a tile that looks exactly as it did before, and build
    mode would be a row in a table. `tile_world` gained the asset's `sha256`
    (CREATE OR REPLACE, no schema change) so the atom knows which bytes to load.
73. **A missing asset is skipped, not fatal.** One artifact the store has lost
    must not make a whole tile uncompilable; `result.instances` counts what was
    actually placed. Same rule as WP2's missing merge child (deviation 43).
74. **`glbmesh.js` refuses a non-canonical GLB.** It reads `meshes[0].primitives`
    without walking a node tree — which is right for canon-v1's one-node output
    and silently wrong for a raw export, whose root rotation it would drop,
    laying the model on its side. It now throws instead. The unit test caught
    this by handing it a raw fixture.
75. **The gizmo is keyboard-driven, and build mode detaches the player.** A drag
    handle needs a picker this client does not have; G/R/T choose move, turn or
    size, X/Y/Z the axis, the brackets and arrows take a snapped step. While
    build mode is on the camera stands still and the pointer is free, which is
    what makes a click a placement rather than a request for pointer lock.
76. **`preview.js` draws what has been placed but not yet compiled.** A published
    tile is splats; a bench put down a second ago is in none of them until some
    tab renders that tile. The preview is built from the same canonical GLB
    `assemble` will bake in, and the splats replace it when the new version
    publishes.
77. **build.spec's click test stubs the ground.** The streamer refuses to refine
    into an unpublished child, so reaching a z14 tile through the real traversal
    means compiling the whole z6-to-z14 ladder — which is `pilot.spec`'s job.
    The ray and the insert are what that test is about; the heightfield is
    covered by `build.test.js` and `player.test.js`. It also had to recompute
    every position in the *current* frame: moving the camera 80 km rebases the
    floating origin mid-test, and a cached local position is then 80 km wrong.

78. **A diff is `{"ops":[…]}`, applied in array order.** Each op names a table
    (feature or instance), an action (insert, update, delete) and its values; a
    feature's geom arrives as GeoJSON. The row's area is always the proposal's
    area and never what the diff says, so a proposal cannot reach outside the
    area it was made against. A delete sets `deleted_at` rather than dropping
    the row, because the world is filtered on it.
79. **Approving is not merging.** `approve()` records an approval and answers
    the count; reaching the threshold does not apply anything. The last approver
    still decides when the world moves, which is one more RPC and one fewer
    surprise.
80. **Grants are made by email, and only by the owner.** A uuid is the only
    other handle a player has, and typing one is not a panel. It lets an owner
    learn whether an address has an account; that oracle is bounded to people
    who already own land, and `area_grants()` shows the addresses only to the
    owner. `set_grant`/`revoke_grant`/`set_required_approvals` are new API
    surface — `grant_` has no write policy, so grants move nowhere else.
81. **Build mode routes a proposer's placement into a proposal.** `look()` now
    falls back from `may_write` to `may_propose`, and `place()` calls `propose`
    with the same columns it would have inserted. That is what "an `edit`
    grantee's write becomes a proposal" means where a player actually works.
82. **`say()` was assigning `className`, which dropped the class the panel is
    found by.** `class="area-status muted"` became `class="muted"` on the first
    message, and every selector naming `.area-status` stopped matching — the
    element looked deleted. The browser test caught it; `catalogui.js` had the
    same pattern, harmless there only because it selects by id.

83. **`transfer_asset_right` moves money only out of the caller's own wallet.**
    TASKS.md describes it as the holder transferring and being paid, which
    would mean debiting a `to_user` who never called — an RPC anyone could use
    to empty a stranger's wallet by "selling" them something worthless. Who
    calls decides which half runs instead: the holder gives the right away
    (amount must be 0), or the buyer calls, pays the holder through `pay`, and
    takes it. The signature is unchanged. A holder-initiated *paid* transfer
    needs a consent record — an offer row — that v1 has no table for.
84. **The last-edition race is gated by a shell script, not by pgTAP.** One
    session cannot race itself, and the lock being tested is what a second
    transaction sees when it wakes on `UPDATE asset SET issued = issued + 1
    WHERE issued < editions`. `db/test/0023_buy.sh` runs sixteen real psql
    clients that spin to the same wall-clock second, the way
    `db/test/0006_concurrency.sh` does: one right, one ledger row, fifteen
    PT409s. Six consecutive runs came back clean.
85. **That script gives every run its own asset.** The ledger is append-only,
    so a fixed SAN left every earlier run's buys sitting under the same
    `buy:{san}:%` prefix and the money assertions counted them. The digest is
    derived from the run's timestamp now. Same class of mistake as the seeds
    in deviation 71 — state outliving the thing that made it.
86. **`buy_asset` grants a right for a free asset too, without a ledger row.**
    `cc0` and `free` cost nothing, and a ledger row for zero would be a lie in
    an append-only book; the right is still recorded, so "who may place this"
    has one answer for every licence.
87. **A second buy is a no-op that returns the right already held.** Not an
    error: `ref` idempotence (Invariant 5) means the second call has nothing
    left to do, and a UI that has lost track should not be punished for asking.

### What WP5 inherits from WP4

- **A model gets one identity however it was exported** (`canon-v1`), and the
  catalog serves it: `catalog.html` uploads, searches and licenses.
- **A player can change the world where they are allowed to**: build mode
  places, moves and deletes; a proposer's change becomes a proposal an approver
  merges; `assemble` bakes what was placed into the tile.
- **Money works end to end**: a bounty is escrowed on a job and released pro
  rata when the tile publishes, and `buy_asset` is one transaction with the
  edition count as its lock.
- **`client/js/wallet.js` is where money is asked about**, and `walletui.js`
  shows it. Build mode hands the wallet the tile the player is looking at, so
  WP5.2's "help render the world" has somewhere to put a price.

## WP5 — Switzerland, the web editor, ops ✅

| task | status | commit | file(s) |
|---|---|---|---|
| 5.1 CH seed | done | see git log | `infra/seed/ch.geojson`, `tools/{geo-common,seed-ch,seed-ch-test,seed-dem,seed-osm}.sh`, `docs/seed-ch.md`, `Makefile` |
| 5.2 Background baseline rendering | done | see git log | `db/0024_progress.sql`, `db/test/0024_progress.sql`, `client/js/{work,workui}.js`, `client/play.html`, `client/test/background.test.js`, `client/test/e2e/background.spec.js` |
| 5.3 Web GIS editor | done | see git log | `client/edit.html`, `client/js/{edit,editui,editmap}.js`, `client/test/edit.test.js`, `client/test/e2e/edit.spec.js`, `tools/vendor.sh` |
| 5.4 XR mode | done, **manual gate unticked** | see git log | `client/js/xr.js`, `client/play.html`, `client/test/xr.test.js`, `client/test/e2e/xr.spec.js`, `docs/xr.md` |
| 5.5 Ops | done | see git log | `tools/{backup,restore,gc-jobs,ops-test}.sh`, `infra/nginx.conf`, `docs/runbook.md`, `Makefile` |
| — verification fixes | done | see git log | `db/0025_tilesforgeom.sql`, `db/test/0025_tilesforgeom.sql`, and deviations 109–115 |

Gate at the end of WP5: 419 pgTAP assertions over 19 files, the concurrency run,
the edition race, 95 API, file-store, seed and ops assertions, 121 node
assertions, 22 test-tile assertions and 40 headless-chromium tests. About twenty
minutes.

**The WP5 gate itself, read literally:** "Switzerland end-to-end at z6…z14 with
z16/z18 pockets" is seeded as far as the sources here allow — the areas, the
15 222 dirty z14 tiles and the jobs on them, over the real outline; the rasters
and the OSM extract for the whole country are deviation 91. "20 tabs working
concurrently without DB errors" is `db/test/0006_concurrency.sh`, which runs 32
workers, 4 editors and 2 stale publishers against one database: 1500 claims, no
atom claimed twice, no duplicate ledger ref, no deadlocks, 0 errors.

### Deviations from TASKS.md, and why

88. **A region is a polygon, not a root tile.** The pilot is one z10 tile and
    every seeding tool was written around it. WP5.1 adds `REGION_GEOJSON` to
    `tools/geo-common.sh`: `geo_tiles()` yields the region's tiles instead, from
    `tiles_for_geom` — the world's own tile maths, so a seeded tile and a
    dirtied one are the same tile — and `seed-dem.sh` and `seed-ortho.sh` cut a
    country without knowing that is what they are doing.
89. **The Swiss border is checked in.** `infra/seed/ch.geojson`, 187 points from
    Natural Earth 1:50m `admin_0_countries` (public domain), which PostGIS puts
    at 41 316 km² against the official 41 285. That is 15 222 z14 tiles, the
    "~14 k" TASKS.md asks for.
90. **The seed writes its own tile rows.** Only `feature` and `instance` fire
    the dirty trigger (ARCHITECTURE, "Triggers"), and ground nobody has ever
    edited has no edit to fire one — so a country would have no tiles to
    compile until somebody drew a road on it. `geo_mark_dirty()` inserts the
    rows the trigger would insert, from the same `tiles_for_geom`, dirty and at
    `expected_version = 1` so `ensure_job` opens a job on them. A tile the world
    already knows is left exactly as it is: re-seeding is not an edit.
91. **The raster half of the CH seed has not been run here.** Geofabrik and
    Overpass are outside this container's egress policy and the whole seed is
    2.4 GB of tiles over about 35 hours of streaming; `docs/seed-ch.md`'s
    timings are one region's measured cost multiplied out, and say so.
    `tools/seed-ch-test.sh` runs the orchestration end to end — plan, refusals,
    areas, tiles, a job on a dirty tile, idempotence, and one real DEM tile when
    AWS is reachable — in a scratch database and a scratch store of its own.
    **Run the full seed on a box with the sources.**
92. **`tools/seed-ch.sh` seeds a root tile at a time.** A country in one
    `gdalbuildvrt` and one transaction prints nothing for hours and then either
    works or does not. The region is clipped to each z10 tile in turn, which is
    what makes progress, an ETA and a resumable interruption possible; the OSM
    pass records which extract each area was seeded from, so a re-run knows what
    is left.
93. **"Help render the world" is two more `caps`, not a new RPC.** `claim_atom`
    already carries `caps` and already filters on it, so WP5.2 adds `ops` (the
    cheap deterministic ops a background tab will take) and `near {lon, lat}`
    (the player's position, which the claim is ordered by). No signature
    changed. Bounty still sorts first: filling in the baseline may not starve
    work somebody has paid for.
94. **The position travels with the claim, not with the worker row.** A player
    moves, and the nearest unfinished tile moves with them; a `worker.caps`
    written once at sign-in would send every later claim to where they were.
95. **The pace is a frame budget, not a frame rate.** `WorkLoop` asks `pace()`
    before every claim and waits when it answers milliseconds. play.html
    measures a smoothed frame time and holds the next atom back while the tab is
    drawing slower than 30 fps; a tab with no renderer to measure — a headless
    worker — passes nothing and never waits.
96. **`GET /api/progress` is public.** What is drawn and what is not is not a
    secret, and a dashboard that needs a token is a dashboard nobody looks at.
97. **The editor reads the world one tile at a time.** PostgREST expresses no
    spatial predicate, so `edit.html` asks the z14 tiles under the viewport for
    their `tile_world()` — the same GeoJSON the compiler reads, already public.
    A view wider than 24 tiles returns nothing and says so; a
    features-in-a-bbox RPC is what this would rather have.
98. **A feature is written with its Z on every vertex.** `feature.geom` is
    `geometry(GeometryZ, 4326)` and a plain PostgREST insert cannot call
    `st_force3d`, so `ewkt()` puts the third ordinate on before the row leaves
    the tab. A proposal takes the other road: its geometry stays GeoJSON and
    `diff_geom()` forces it 3D when the proposal merges.
99. **OpenLayers is the built bundle, not its ES modules.** They import each
    other by bare specifier and `client/` has no bundler to resolve one with.
    `make vendor` fetches `ol.js` and `ol.css` beside the PlayCanvas build, and
    the browser test routes the CDN at them.
100. **XR is a budget and a teleport, not a second viewer.** `?xr=1` hands the
    streamer `XR_LIMITS` (8 M splats, 24 tiles, 2 in flight) and offers a
    button; `client/js/tiles.js` already drops what does not fit, so nothing
    else had to know. The budget is lowered by the flag rather than by the
    session, because the tiles have to be loaded before there is anything to
    enter.
101. **The camera is reparented to a rig only when a session starts.** Outside
    XR the page is exactly the page the other thirty-odd browser tests fly.
    Teleport moves the rig; smooth locomotion is not offered at all.
102. **WP5.4's acceptance is unrun.** There is no headset here and no XR runtime
    in headless chromium. The gate checks that `?xr=1` takes the smaller budget
    and that a browser without a runtime says so and keeps rendering;
    `docs/xr.md` lists what to check on a device. **Run it on a headset.**
103. **The backup takes the dump first and the bytes second, and the restore
    the other way round.** Every writer here puts bytes down before the row that
    names them, so a dump taken first can only name artifacts already on disk:
    the worst drift a backup holds is litter. A restore reversed for the same
    reason — a database ahead of its store names artifacts nobody can resolve,
    and `can_write` refuses a second upload of a registered sha256, so those
    bytes could never be supplied again.
104. **`tools/gc-jobs.sh` deletes files, not directories.** An artifact is
    written once, so an atom that recomputes bytes somebody already uploaded
    records *their* path — a live job's input can sit in a dead job's directory.
    It is a dry run unless given `--apply`, and every candidate is re-checked
    against the database in the statement that authorises the delete.
105. **`tools/restore.sh` re-applies `app.jwt_secret`.** It is a per-database
    setting, `pg_dump` never writes one, and without it `auth.sign()` raises:
    a restore that skips it looks exactly like "login is broken".
106. **The restore drill is a gate, not a paragraph.** `tools/ops-test.sh` drops
    a scratch database, empties its store, puts both back from a backup alone,
    and checks the drift — on every `make api-test`. A drill nobody runs is a
    backup nobody has.
107. **Applying the migrations anywhere sets the `authenticator` password
    everywhere.** `ALTER ROLE` is a cluster object, so a scratch-database test
    that applies `db/0007_api.sql` with a different `$AUTHENTICATOR_PASSWORD`
    silently breaks the developer's own PostgREST. It cost an afternoon once;
    `seed-ch-test.sh` and `ops-test.sh` both put it back on the way out, and
    `docs/runbook.md` names the symptom.
108. **`train.spec.js`'s PSNR assertion is stochastic.** Training a z16 tile
    over SwiftShader at a size that finishes leaves "did the held-out PSNR
    improve" a close question: one full-gate run here came back 0.05 dB down,
    and the next was fine. It is a real signal at a real size and a coin at this
    one; deviation 57 already says to run WP3.1's acceptance on a GPU, and this
    is the second reason to.

### What adversarial verification of WP5 found, and what was done

An independent pass over WP5.1, 5.3 and 5.5 tried to break what had been
committed. Two findings were real bugs, and the rest were claims the code did
not support. All of them are fixed here; each fix carries the test that catches
it coming back.

109. **`tools/gc-jobs.sh` deleted a live atom's input.** It protected what live
    atoms *produced* — `result.path`, `result.files`, `output_sha256` — and
    never what they were going to *read*. `new_atom` dedups `atom_hash` across
    jobs, so an unfinished atom's input routinely sits in an older, settled
    job's directory, and deleting it is unrecoverable: `can_write` refuses a
    second PUT of a registered sha256 for ever. It now reads `deps` and
    `inputs` as well, and `tools/ops-test.sh` builds exactly that shape and
    asserts the file survives — with the old query, it does not.
110. **`tools/restore.sh --check` reported a clean world when the database was
    down.** `named_paths` was consumed through a process substitution, which
    hides psql's exit status, so a dead server produced "0 paths, 0 missing" and
    exit 0 — from the check the runbook schedules daily. It now fails with
    exit 2 and says so, and the gate asserts it.
111. **`--force` did not clean the target.** `pg_restore` into a database that
    already had the schema produced hundreds of "already exists" errors and a
    non-zero exit, which under `set -e` took `app.jwt_secret` and the drift
    report down with it — so the restore looked like "login is broken". A
    database with tables in it is now dropped and rebuilt, and `--force` is what
    permits that. Restoring over `make db-reset`'s output is a gate case.
112. **`ALTER FUNCTION tiles_for_geom(...) ROWS 8` does not work**, which is
    worth writing down because it is the obvious fix. The function is
    `LANGUAGE sql`, so the planner inlines it and discards the declared row
    count: the plan, the 5 000-row estimate and the 6.4e7 cost come back
    byte-identical. A per-function `SET` clause is what blocks inlining, so
    `db/0025_tilesforgeom.sql` is `SET jit = off` — measured here at 158 ms a
    feature before and 0.93 ms after, for every writer and not only the seeds.
113. **Two gate assertions were green for the wrong reason.** `seed-ch-test`'s
    "a country-sized region with no ortho mosaic stops the run" passed because
    `check_ortho` refuses a wide region, not because `DEM_SRC=/nonexistent.tif`
    was caught — nothing validated a named source at all, and a real CH run must
    name one. `ops-test`'s "a real client is never limited" sent `seq 1 -10`,
    which is no requests, for any burst under 10. Both are fixed, and the
    preflight now opens every named dataset with `gdalinfo` before the first
    write.
114. **`edit.spec.js` did not test that what was drawn is what was stored.**
    Replacing `ewkt()` with a hardcoded triangle passed every geometric
    assertion — `st_within` against an 11 km area is a loose net. It now asks
    the map where the clicks landed and compares the stored ring with them by
    Hausdorff distance in metres.
115. **The editor refreshed once per moveend, unthrottled.** A pan is up to 24
    `tile_world` calls, `pick()` fires two moveends by itself, and
    `paintFeatures` clears before it repaints — so overlapping rounds were both
    expensive and wrong. Debounced, and only the newest round paints.

## Close-out review of WP0–WP2

Done in a separate session while WP3–WP5 were landing on the same branch, and
rebased onto them afterwards. The three work packages were audited against `TASKS.md` and the
invariants. Everything found was fixed in one commit; nothing in `TASKS.md`
was re-scoped. The install and user manual is `docs/manual.md`.

**Database (`db/0026_review.sql`, tested by `db/test/0026_review.sql`)**

- An `instance` could be placed outside its area: `bump_rev` read the STORED
  generated `geom`, which is null in a BEFORE trigger. It now builds the point
  from `lon`/`lat`.
- `pay()` passed the caller's ref through, so a player could pre-empt
  `pay:{job}:{worker}` and block a publish for ever. User refs are namespaced
  `user:{account}:{ref}`; system refs stay bare.
- `transfer()` locks the paying account before the balance check (two
  concurrent payments could both pass it).
- `ensure_job` with a bounty escrowed on every call; it now escrows only when it
  creates the job. `set_bounty` may be called again to top up (one ref per row).
- A cancelled job kept its bounty in escrow. `refund_bounty` returns it to
  whoever paid, one ledger row per escrow row.
- `release_escrow` used a named temp table and failed on the second payout in a
  transaction.
- `disagreed()` marked only the second worker bad: `recheck_atom` had cleared
  the first from the row. Everyone whose structural pass vouched for the
  standing answer is marked now (`db/test/0015_structural.sql` expects 2).
- `recheck_atom` refuses trained tiles (z ≥ 16): their sog is judged
  perceptually and its verify atoms are spent. A job reopened for a re-check
  closes again in `advance_atoms` once the tile is published at that version and
  nothing is pending, since `publish_tile`'s CAS will not run twice.
- Internal SECURITY DEFINER functions (`transfer`, `release_escrow`,
  `expire_claims`, `build_dag`, …) were executable by every role through the
  default PUBLIC grant. Revoked, and the default for new functions is revoked.

**Client**

- `merge-v1` read the children from the live `tile` rows. A child republished
  after the DAG was built no longer matched any input sha and was silently
  dropped, so one `atom_hash` could produce different bytes at different times
  (Invariant 7 would then blame both workers). Children are now the sogs named
  in `atom.inputs`, found through the sog atom that made them when no tile
  publishes them any more (`client/atoms/merge.js`, `client/js/inputs.js`).
- Streaming: a tile stays until every tile replacing it is in the scene (no
  hole while refining) — which put parent and children in the scene at once
  and surfaced an engine trap: destroying a splat entity in the same frame the
  sorter collected its placement crashes `_updateWorldState`. An outgoing
  entity is now disabled at once and destroyed a tick later (`release()`).
  Also, a failed load backs off 30 s instead of retrying every
  frame, a load or swap that finishes after its tile was dropped is unloaded,
  and of two swaps in flight only the newest is adopted. `play.html` pages
  through every tile row instead of stopping at 5 000.
- Worker loop: stop-then-start no longer runs two loops; a failing claim is
  logged, once per streak; logs also go to `console.debug`.
- Terrain: a 404 is no field, and a swapped or unloaded tile forgets its
  heightmap and colliders.
- `assemble` no longer swallows an ortho fetch error into a grey tile; every
  JSON fetch checks `res.ok`.

**Tooling and infrastructure**

- The seed user was an `admin` with a fixed password anyone could log in with.
  Its hash is locked after creation.
- A `/geo` tile could be overwritten by `FORCE=1`; now a re-cut must reproduce
  the bytes (Invariant 1). `assemble` still fetches `/geo` by path, not by hash
  (see `infra/seed/README.md`); pinning those into the atom's inputs is open.
- `infra/compose.yml`: volume paths were relative to `infra/` while every tool
  roots the store at `./infra/files`; fixed with `--project-directory .`. Ports
  bind to loopback, passwords have no defaults, and nginx serves `client/`
  under `/app/`. Still never started on a box with a Docker daemon.
- `provision.sh` exits non-zero on anything but 2xx/401/409.
- `CURL_CA_BUNDLE` is only forced where the Debian bundle exists.

### WP3–WP5, reviewed after the rebase

The same audit was run over WP3–WP5 once the review had been rebased onto them.
WP4 was not audited: the session ran out before its reviewer reported.

- **`submit_verification` could be called by any player, on any submitted sog,
  without ever claiming a verify atom or holding the trust a claim needs** —
  three accounts could publish a trained tile between them, and one could
  drive a trainer's trust to zero by calling it in a loop, since every call
  credited again. `db/0027_verifyguard.sql`: the API wrapper admits a verdict
  only from a tab holding a verify atom of that job, or as a spot check that
  `spot_due` itself says is due; the public function is no longer executable by
  clients; a verifier's second word on the same output replaces their row and
  moves nothing else; a sog without a trainer is not an error. WP3's internal
  functions lose the PUBLIC grant as WP0–WP2's did.
- `client/atoms/train.js` disposes the GPU buffers in a `finally`, so a
  training run that throws does not leak them.
- `infra/nginx.conf` no longer attaches the one-year `immutable` header to a
  404 (`always`): the editor asks for `/geo` tiles by coordinate, and a tile
  not yet seeded would have been cached as missing for a year.
- `tools/restore.sh` and `tools/ops-test.sh` recreated store directories as
  whoever ran them; nginx's worker then could not write there, and the first
  catalog upload after the restore drill was a 500. They are created `1777`,
  as the store root is.

Gate after the review, on top of WP5: 450 pgTAP assertions over 22 files, the
concurrency run (1500 claims, 0 errors) and the edition race, the API,
file-store, seed and ops assertions, the node assertions, 22 test-tile
assertions and the headless-chromium tests, with the pilot seeded and
OpenLayers and Draco vendored.

**Known, not fixed** (WP3–WP5)

- A verify atom claimed at the moment of a rejection ends `failed` after three
  expiries, and `verify_required` still counts it, so that sog can never reach
  three passes (`db/0017_verify.sql`, `retrain`). The third rejection also
  leaves the job's other verify atoms claimable. Fix in `retrain`: send every
  sibling verify atom to `waiting`, and count only unfailed ones.
- `publish_sog`'s result is ignored in `submit_verification`: a CAS miss leaves
  a `verified` sog and an open job.
- The "one check for a trusted trainer" rule reads the train atom's worker,
  which is null when the DAG is built; it only fires on the atom-reuse path.
- No structural rule checks a verify result against its own numbers
  (`passed` vs `psnr` vs `min_psnr`); `db/0018_spot.sql` has no pgTAP file.
- `tools/gc-jobs.sh` deletes bytes whose `artifact` rows remain, which the
  runbook itself calls unrecoverable: a later atom that reproduces those bytes
  gets a 403 from `can_write` and finds nothing to dedupe against. It also
  skips cancelled jobs, whose `/jobs` grow for ever. Both need a decision
  (a tombstone `can_write` consults, or gc of cancelled jobs) — not taken here.
- nginx's PUT limit is keyed on the client address; behind the TLS proxy the
  manual recommends, every player shares one bucket (`real_ip` is the fix).
- "Rate-limited to keep ≥ 30 fps" paces between atoms only, and only with
  "help render the world" on.
- `claim_atom`'s "nearest" is a distance in degrees.

**Known, not fixed** (WP0–WP2)

- `submit_atom`, `can_write` and `build_dag` are 63–68 lines (rule: < 60).
- Functions without their own pgTAP test: `instance_glbs`, `atom_state_guard`,
  the `can_write` `/jobs` and `/assets` branches (covered by
  `tools/files-test.sh` only), `deterministic`, the `sample` structural rules.
- `db/test/0006_concurrency.sh` prints its error count but does not assert it.
- The gate is green with browser tests skipped when the engine is not vendored
  or no database is reachable; it says so, but does not fail.
- Dead exports in `client/lib` and `client/js` (`envelope`, `geodeticToEcef`,
  `parseKey`, …) are left in place.
- Token expiry (12 h) has no refresh: a background worker tab is asked to sign
  in again and its claim expires.


## Coordinate systems, defined once

`db/0056_crs.sql` adds `world_srid()` (read off `area.geom`), `tile_srid()`
and `tile_bbox_merc()`. `server/splatworld/crs.py` and `client/lib/crs.js`
repeat the two codes for code that runs without a database, and a test in each
(`server/test_crs.py`, `client/test/crs.test.js`) pins them to the database
and refuses an EPSG code spelled anywhere else in that tree. `gis.tile` has a
typed geometry column, so GeoServer no longer sees an unknown native SRS on it.
`infra/geoserver/provision.sh` is gone: it published the layers in the tile
projection with `REPROJECT_TO_DECLARED`, which `gsprovision.py` had already
found to store Mercator numbers raw; the Python provisioner is the one path.
