# TASKS.md — splatworld

One task = one commit `WPx.y: title`. Run `make gate` before every commit. A WP is closed when its **WP gate** passes. Do not reorder across WPs.

Legend: **D** deliverable · **A** acceptance · **G** gate command

---

## WP0 — Foundation (Postgres, PostgREST, nginx, GeoServer). No client, no rendering.

### WP0.1 Repo skeleton + tooling
- D: layout from CLAUDE.md; `Makefile` with `db-reset db-test api-test client-test lint gate`; `infra/compose.yml` with postgres:16-postgis, postgrest:v12, nginx:1.27 (built with dav module), geoserver:2.26; `.env.example`.
- A: `docker compose up` starts all four; `make db-reset` applies zero migrations without error.
- G: `make db-reset`

### WP0.2 Schema migration
- D: `db/0001_schema.sql` — every table from ARCHITECTURE §3 with PKs, FKs, CHECKs, GiST indexes on all geometry, index on `atom(state, op)`, `UNIQUE(job.z,x,y,target_version)`, `UNIQUE(atom.atom_hash)`, `UNIQUE(ledger.ref)`. `balance` view. `REVOKE UPDATE, DELETE ON ledger FROM PUBLIC`.
- A: `db/test/0001_schema.sql` (pgTAP) asserts existence of every table/column/index; inserting into `ledger` then `UPDATE` fails for role `player`.
- G: `make db-test`

### WP0.3 Auth + roles
- D: `db/0002_auth.sql`: `auth.user(id, email, pw_hash, role, created_at)`, pgcrypto, `login(email,pw) → jwt` (HS256 with `app.jwt_secret`), `register(email,pw)`; roles `anon`, `player`, `admin`; `current_user_id()` helper reading `request.jwt.claims`.
- A: pgTAP: register, login returns token whose payload has `sub` and `role`; wrong password raises.
- G: `make db-test`

### WP0.4 Row-level security
- D: `db/0003_rls.sql`: RLS on all tables. Rules: everyone reads world/catalog/tiles; `feature`/`instance` writes iff `is_area_writer(area_id)` (owner or `direct_edit`); `proposal` insert iff owner/`edit`/`direct_edit`; `approval` iff owner/`approve`; `asset_right`, `ledger`, `tile`, `job`, `atom`, `artifact` write only via SECURITY DEFINER functions (no direct grants).
- A: pgTAP with `SET ROLE player; SET request.jwt.claims`: 12 denial cases + 6 allow cases listed in the test file header.
- G: `make db-test`

### WP0.5 Dirty trigger + versioning
- D: `db/0004_tiles.sql`: `tilemath` SQL functions (`tiles_for_geom(geom, min_z, max_z) → setof (z,x,y)` for even zooms; `tile_bbox(z,x,y) → geometry`); trigger on `feature`/`instance` insert/update/delete: for each intersecting tile with `z ≤ area.detail` (and all ancestors to z6): upsert `tile` row, `dirty=true`, `expected_version+1`. Nothing else in the trigger (Invariant 4).
- A: pgTAP: inserting a feature in a detail-14 area bumps exactly the 5 tiles (z6…z14) that contain it; two edits → +2; an edit outside any area raises.
- G: `make db-test`

### WP0.6 Jobs + atoms state machine
- D: `db/0005_jobs.sql`: `ensure_job(z,x,y)` idempotent (returns existing open job for `(tile, expected_version)`; cancels older open jobs for the same tile); builds atom DAG per ARCHITECTURE §5 with `atom_hash` computed from op‖algo_version‖inputs‖params‖seed; `claim_atom(caps jsonb)` with `FOR UPDATE SKIP LOCKED`, caps filter (`webgpu`, `vram_gb`); `heartbeat`; `expire_claims()` (called inside `claim_atom`, not by cron); `submit_atom` with structural checks table `structural_rule(op, rule sql)`; state transitions enforced by CHECK + function guards.
- A: pgTAP: DAG shape for z18 (1 assemble, N frame, 1 train, 1 sog, 3 verify) and z14 (1 merge, 1 sog); `ensure_job` twice → same id; claim marks `claimed`; expired claim reverts to `ready` and increments `attempts`; 3rd expiry → `failed`; submit on wrong state raises; structural rule rejects `splat_count > budget`.
- G: `make db-test`

### WP0.7 Concurrency torture test
- D: `db/test/0006_concurrency.sh`: spawns 32 parallel `psql` clients doing claim/heartbeat/submit loops over 500 ready atoms plus 4 clients editing features (bumping versions) plus 2 clients calling `publish_tile` with stale versions.
- A: after run: no atom claimed twice (audit via `verification`/log table), no duplicate `ledger.ref`, every `publish_tile` with stale version returned `false`, `tile.published_version ≤ expected_version` everywhere, no deadlocks in postgres log.
- G: `make db-test` (this script is part of it)

### WP0.8 Publish + escrow + ledger functions
- D: `db/0006_publish.sql`: `publish_tile` CAS per ARCHITECTURE §4 (bumps parent dirty/expected_version; pays escrow pro rata by `result.gpu_seconds`, ref `pay:{job}:{worker}`); `set_bounty`; `pay`; `register_artifact`; system accounts `escrow`, `treasury`.
- A: pgTAP: publish with `target_version == expected_version` succeeds and bumps parent; stale publish returns false and changes nothing; double publish of the same version is a no-op; escrow of 10 split 6/4 by gpu_seconds; retrying `pay` with same `ref` raises unique violation and leaves balance unchanged.
- G: `make db-test`

### WP0.9 PostgREST wiring
- D: `infra/postgrest.conf` (schema `api`, `anon` role, jwt secret from env); `db/0007_api.sql` creates schema `api` with views/functions exposed; `tools/api-test.sh` (curl): register, login, read tiles as anon, write feature as player (allow + deny), `ensure_job`, `claim_atom`.
- A: all curl assertions pass against compose stack.
- G: `make api-test`

### WP0.10 nginx immutable file store
- D: `infra/nginx.conf`: static `/assets /tiles /jobs /geo` with `Cache-Control: public, max-age=31536000, immutable`; `PUT` via dav module restricted by `auth_request /auth` → PostgREST `rpc/can_write` (headers: path, `X-Sha256`, `Content-Length`, Authorization); nginx computes nothing — the client sends the sha, `register_artifact` after upload is trusted only after a later `verify`/hash check re-downloads (v1 accepts; note in code). `can_write` in `db/0008_files.sql`: allowed iff (`/jobs/{atom}/…` and atom claimed by caller) or (`/assets/{sha}.glb|.webp` and authenticated) or (`/tiles/z/x/y/{sha}.sog` and caller holds the `sog` atom for that tile); sha not already in `artifact`; overwrite always denied (`PUT` on existing path → 409).
- A: `tools/files-test.sh`: PUT without token → 401; PUT to unreserved path → 403; PUT reserved path → 201; second PUT same path → 409; GET returns immutable headers.
- G: `make api-test`

### WP0.11 GeoServer + QGIS admin path
- D: `infra/geoserver/` workspace `splatworld`, datastore → PostGIS, layers `feature_*` (SQL view per kind), `area`, `tile` (styled by dirty/published_version); WFS-T enabled with GeoServer user `admin` mapped to Postgres role `admin`; `gis/splatworld.qgz` QGIS project (WFS-T layers + WMTS ortho/DEM placeholders + forms for props).
- A: manual gate, documented in `gis/README.md`: draw a `forest` in QGIS → commit → `GET /api/feature?kind=eq.forest` returns identical geometry; `tile` rows show dirty.
- G: `make api-test` + manual checklist ticked in README

**WP0 gate:** `make gate` green; concurrency test green; QGIS→PostgREST round-trip documented.

---

## WP1 — Client core: viewer + streaming. No atoms yet; uses hand-made test tiles.

### WP1.1 Client scaffold
- D: `client/play.html`, `client/js/api.js` (fetch wrapper, JWT in memory, refresh), `auth.js` (login/register UI), `lib/tilemath.js` (mirrors SQL: lonlat↔tile, tile bbox, local ENU frame, ancestors/children), `test/tilemath.test.js` (node) cross-checked against 50 fixture rows exported from SQL `tiles_for_geom`.
- A: fixtures match bit-for-bit.
- G: `make client-test`

### WP1.2 Test tiles
- D: `tools/make-test-tiles.mjs`: generates synthetic `.sog` tiles (coloured terrain-like blobs) for a 2×2 z10 area and their z6/z8 parents, uploads via PUT as `admin`, registers artifacts, publishes via `publish_tile`.
- A: `GET /api/tile` lists 7 published tiles with manifests.
- G: `make client-test`

### WP1.3 Tile streaming
- D: `js/tiles.js`: SSE traversal from z6 (`sse = geometric_error_m·screenH/(2·dist·tan(fov/2))`, refine at > 2 px, only if all children published), frustum cull, ≤ 40 loaded / ≤ 25 M splats, LRU unload, ≤ 4 in-flight, hysteresis; loads `.sog` via PlayCanvas `GSplatResource`; `js/origin.js` floating origin rebase every 5 km; per-tile entity placed by manifest `origin`.
- A: playwright headless: fly camera along a scripted path over the test tiles; assert loaded-tile set at 5 checkpoints; no entity position exceeds 1e5 in local coords.
- G: `make client-test`

### WP1.4 Player controller + collision
- D: `js/player.js`: WASD/fly toggle, mouse look; ground from `height.r16` of the finest loaded tile (bilinear), `colliders.json` OBB slide. Kinematic, no physics lib.
- A: playwright: player walking across a test tile with a stepped heightmap ends at expected height ±0.05 m.
- G: `make client-test`

### WP1.5 Hot swap
- D: poll `GET /api/tile?z,x,y…&select=published_version,sog_sha256` for loaded tiles every 30 s; on change fetch new sog, swap entity, dispose old.
- A: playwright: publish a new version of a loaded test tile via RPC → entity's asset URL changes within 35 s, no frame with zero tiles.
- G: `make client-test`

**WP1 gate:** fly z6→z10 over the test region in a browser; hot swap works.

---

## WP2 — Atoms without training: assemble, frame, merge, sog, work panel, real geodata.

### WP2.1 Geo input seeding (dev tooling, runs on dev box)
- D: `tools/seed-dem.sh` (Copernicus GLO-30 + swissALTI3D 2 m → `/geo/dem/{z}/{x}/{y}.r16` for z10–z18 of one pilot z10 tile, uint16, 256²); `tools/seed-ortho.sh` (swissimage 2 m → `/geo/ortho/…webp` 512²); `tools/seed-osm.sh` (osm2pgsql flex → `feature` rows: road, forest, water, footprint with height/levels, `area` = one system area per z12 with detail 14). Registers each geo tile as an artifact (kind dem/ortho).
- A: counts in README; `GET /geo/dem/14/…r16` served immutable.
- G: `make api-test`

### WP2.2 Worker runtime
- D: `js/work.js`: worker registration (caps: webgpu, adapter info, vram estimate, algo versions), claim loop, heartbeat every 60 s, input fetch with cache (Cache API keyed by sha), atom dispatch to `atoms/*.js` inside a Web Worker with OffscreenCanvas, upload via PUT with `X-Sha256`, `register_artifact`, `submit_atom`; structured logs; "work" panel in play.html (my dirty tiles → `ensure_job` → run; background toggle; GPU status).
- A: playwright with a fake `noop` atom registered in DB: claim → upload → submit → verified; heartbeat keeps claim alive across 6 min.
- G: `make client-test`

### WP2.3 `assemble-v1`
- D: `atoms/assemble.js`: builds PlayCanvas scene from snapshot: terrain grid (res by z), terrainmod ops (raise/lower/flatten/smooth), road cuts (profile by type), footprints extruded (flat/gable/hip), forest scatter (seeded Poisson disk, species mix, tree GLBs from catalog by SAN), instances placed & snapped, water planes; ortho draped + slope/height procedural blend. Outputs one tar artifact: `init.ply` (area-weighted surface samples, colour from material/ortho, 30 % of budget), `height.r16`, `colliders.json`, `scene.json` (for `frame`).
- A: unit: deterministic — same inputs+seed → identical `init.ply` sha on two runs; playwright: assemble the pilot z16 tile with real data in < 60 s on the dev GPU.
- G: `make client-test`

### WP2.4 `frame-v1`
- D: `atoms/frame.js`: camera sets `z18-v1` (3 rings×24 az + 4 street loops + 8 top-down), `z16-v1` (2 rings×24 + 8 top-down); renders scene from `scene.json` off-screen at 1024², WebP q90, `transforms.json` (nerfstudio format, OpenGL convention), frames chunked into ranges so one atom = ~20 frames.
- A: frame count/pose ids match spec; two workers rendering the same range produce PSNR > 45 vs each other (rasteriser drift tolerance).
- G: `make client-test`

### WP2.5 `merge-v1` (deterministic)
- D: `atoms/merge.js`: load 16 child plys (missing child → sample from parent-level assemble init, flagged in params); transform to parent frame; voxel-cluster with integer voxel keys (`floor(p/voxel)`), fixed sort order, integer accumulation where possible, no atomics; cluster → weighted mean pos/colour, merged covariance; cap to budget by deterministic top-k (weight, then key). Output fp16 ply.
- A: same inputs → byte-identical output on two different GPUs (test on dev GPU + software WebGL via swiftshader in CI); 16 test children → parent within budget.
- G: `make client-test`

### WP2.6 `sog-v1`
- D: `atoms/sog.js`: vendored splat-transform core → `.sog`; `lib/sogenc.js` WebP packing via canvas; deterministic (fixed quantisation, no time-based seeds).
- A: encode → decode (PlayCanvas loader) → positions within quantisation error; byte-identical on re-run.
- G: `make client-test`

### WP2.7 Structural checks live
- D: `structural_rule` rows for each op (bytes>0, count≤budget, bbox ⊂ tile+10 m, `result.finite=true`, frame count == range size); hash verification for `merge`/`sog` in `submit_atom` (second submission of same `atom_hash` with different output → both `failed`, job re-opens).
- A: pgTAP + playwright: corrupt a merge output → rejected; matching hash → `verified` without a verify atom.
- G: `make gate`

### WP2.8 End-to-end: merged world
- D: run `ensure_job` for the pilot z10 tile's 16 z12 children and the z10 itself (baseline via `merge` from assembled z14s? — no: baseline path is `assemble` at z14 then `merge` up). Concretely: DAG for z14 baseline = `assemble → sog`? **Decision:** z14 baseline uses `assemble` init samples directly (no train): add op `sample-v1` = assemble's `init.ply` at 100 % budget → `sog`. Update ARCHITECTURE §5 accordingly in this task.
- A: pilot z10 region fully published z6…z14 by one browser tab in the background; viewer streams it.
- G: `make gate` + screenshot committed under `docs/`

**WP2 gate:** real DEM/ortho/OSM region visible as splats, produced entirely by a browser tab; merge is byte-deterministic.

---

## WP3 — Training + perceptual verification

### WP3.1 Splat.js integration
- D: vendor Splat.js under `client/vendor/splatjs/` (pin commit, MIT notice); `atoms/train.js`: skip SfM, inject poses from `transforms.json`, init from `init.ply`, budget/iters from params (`z18: 2 M / 7 k`, `z16: 600 k / 5 k`), MCMC growth capped, prune (opacity < 0.05, outside bbox+margin), fp16 ply out, `result.gpu_seconds`. If Splat.js needs a patch for pose injection, keep it as `vendor/splatjs.patch` applied by `make vendor`.
- A: pilot z16 tile trains in < 8 min on dev GPU; PSNR vs 4 held-out frames ≥ 24.
- G: `make client-test` (GPU-gated)

### WP3.2 `verify-v1`
- D: `atoms/verify.js`: load `.sog`, render 2 stored poses, compare to reference frames (PSNR); `submit_verification`. DAG wiring: 3 verify atoms with `require_distinct_workers=true`, claimant ≠ trainer.
- A: pgTAP: 3 passes → `verified`; one fail → `failed`, trainer's `worker_op_stats.bad++`; same worker cannot claim two verifies of one train.
- G: `make gate`

### WP3.3 Owner spot-check
- D: on tile load in play, if `tile.published_by` ≠ me and I own an intersecting area, and last spot-check > 7 d: run one `verify` locally, `submit_verification(kind='perceptual', spot=true)`; failure flags tile `suspect=true` (column added by migration `0009_spot.sql`) and re-opens a job.
- A: playwright: tamper a published sog → owner visit flags it.
- G: `make gate`

### WP3.4 Trust
- D: `submit_verification` updates `worker.trust` (±0.05 / −0.2), `worker_op_stats`; `claim_atom` requires trust ≥ 0.3 for `train`, ≥ 0.6 for `verify`; `ensure_job` sets `verify` count to 1 if trainer trust ≥ 0.95 (config `app.verify_min`).
- A: pgTAP transitions.
- G: `make db-test`

**WP3 gate:** a z18 tile of the pilot region trained in one tab, verified by three others, published, streamed.

---

## WP4 — Catalog, building, areas, money

### WP4.1 Canonical GLB + SAN
- D: `lib/canon.js` (`canon-v1`): parse GLB, strip extensions except KHR_materials_*, decode Draco if present, resize textures > 2048, re-centre origin to bbox bottom-centre, Y-up, metres, deterministic serialisation (sorted JSON keys, fixed buffer order); `lib/hash.js` (sha256 via WebCrypto, streaming); SAN derivation; `register_asset` RPC; `catalog.html` (search, detail, upload with near-duplicate check by bbox/tris/name, thumb rendered client-side).
- A: unit: 5 fixture GLBs exported from 3 tools → same SAN; PUT + register round-trip.
- G: `make gate`

### WP4.2 Build mode
- D: in play: select area, place asset from catalog (raycast to heightmap), transform gizmo (translate/rotate/scale, snap), writes `instance`; delete; undo (client-side); shows tile dirty badge and "render now" (→ `ensure_job`).
- A: playwright: place → instance row → tile dirty → render → new version visible.
- G: `make gate`

### WP4.3 Areas, grants, proposals
- D: migrations for `propose/approve/merge_proposal` (diff = list of feature/instance ops, applied in `merge_proposal` under owner's authority); UI: area panel (owner, grants CRUD, rules `required_approvals`), proposal list with diff preview & approve.
- A: pgTAP: `edit` grantee's write becomes a proposal; owner approves → merged → tile dirty; direct_edit bypasses; non-grantee denied.
- G: `make gate`

### WP4.4 Money
- D: `account` auto-created on register; `pay`, `set_bounty`, escrow release on publish (already); wallet UI; bounty UI on dirty tiles; `buy_asset` for `paid`/`limited` with `editions/issued` lock; `asset_right` transfer via `pay` + update in one function `transfer_asset_right`.
- A: pgTAP: two concurrent `buy_asset` on last edition → exactly one succeeds; playwright: stranger renders my bounty and their balance increases.
- G: `make gate`

**WP4 gate:** stranger renders my bounty and gets paid; I buy their asset and place it; edit-grantee proposal flow works.

---

## WP5 — Switzerland baseline, web editor, polish

### WP5.1 CH seed
- D: seeding tools run for all of CH (z6…z14 inputs, OSM CH extract, system areas detail 14); `docs/seed-ch.md` with sizes/timings.
- A: ~14 k z14 tiles with `dirty=true`, jobs creatable.
- G: `make api-test`

### WP5.2 Background baseline rendering
- D: work panel "help render the world" — claims unbountied `sample`/`merge`/`sog` atoms nearest to the player first (uses cached neighbourhood inputs); rate-limited to keep ≥ 30 fps while playing.
- A: dev box tabs render the pilot canton overnight; progress dashboard (`GET /api/progress` view).
- G: `make gate`

### WP5.3 Web GIS editor
- D: `edit.html`: OpenLayers, layers from PostgREST GeoJSON (read) and PostgREST writes (no WFS-T); draw/edit road/forest/water/footprint/terrainmod with prop forms; area overlay; permission-aware.
- A: playwright: draw forest → feature row → tile dirty.
- G: `make gate`

### WP5.4 XR mode
- D: `?xr=1`: WebXR session, lower budgets (≤ 8 M splats), teleport locomotion.
- A: manual on a headset, documented.
- G: `make client-test`

### WP5.5 Ops
- D: `tools/backup.sh` (`pg_dump` + rsync `/assets /tiles`), `tools/gc-jobs.sh` (delete `/jobs/*` older than 7 d for done jobs), nginx rate limits on PUT, `docs/runbook.md`.
- A: restore drill documented and executed once.
- G: `make gate`

**WP5 gate:** Switzerland end-to-end at z6…z14 with z16/z18 pockets; 20 tabs working concurrently without DB errors.

---

## Open decisions to confirm before WP2.8

1. z14 baseline without training: `sample-v1` (assemble samples at full budget → sog). Accept lower quality for the baseline; retrain later where areas raise `detail`.
2. Frame atoms chunked at 20 frames — one z18 job = ~6 frame atoms, spreadable across tabs.
3. `can_write` trusts client-declared sha at upload; integrity is enforced at first verify/hash check, not at PUT. Acceptable for v1.
