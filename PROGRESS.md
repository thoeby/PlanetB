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

| task | notes for whoever picks it up |
|---|---|
| 1.2 Test tiles | Uploads go through nginx PUT (`can_write` allows `/tiles/z/x/y/{sha}.sog` only to the holder of that tile's sog atom) then `register_artifact` then `publish_tile`. |
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

## WP2–WP5 ⬜

Not started. WP2.8 lists three open decisions in `TASKS.md` that should be
confirmed with the project owner before WP2.8, not silently assumed.
