# ARCHITECTURE.md — splatworld v3.1

```
  QGIS (a player) ─ SQL/login ─▶ PostgreSQL + PostGIS   (row-level security)
  browser ───────── REST/JWT ──▶ PostgREST ────▶ the same database
  browser ───────── GET / PUT ─▶ splatworld/nginx ▶ /assets /tiles /jobs /geo /app
  the server ────── WCS ───────▶ GeoServer             (the operator's elevation)
```

Four processes (the file server is nginx or `server/`'s `splatworld`, Invariant 10). All logic = SQL + client JS.

QGIS connects to the database as the player, with a login of their own
(`db/0065_playerroles.sql`), so what a person may draw is decided by exactly
the policies that decide it in the browser. GeoServer publishes the operator's
elevation over WCS and is asked for nothing else.

Invariant 9, in full: outside participants — QGIS, process servers — act as
players with logins of their own, under RLS. The server decides and computes
nothing, and sends nothing out. A process server that runs a flow pulls what it
needs over REST and writes back through the same RPCs a player's tab uses.

## 1. Concepts

| concept | definition |
|---|---|
| **artifact** | immutable file, addressed by `sha256`; kind ∈ glb, thumb, dem, ortho, frames, init_ply, dataset, ply, sog, height, colliders, height_edit, cover, flow, material, plugin, profile, collection, lod (`db/0183`) |
| **tile** | `(z,x,y)`, z ∈ {6,8,10,12,14,16,18}; has `expected_version` (world-input snapshot counter) and a pointer to its current published `sog` artifact |
| **world revision** | `feature.rev` / `instance.rev` monotonically increasing per row; a tile's `expected_version` bumps on any intersecting write |
| **job** | "compile tile (z,x,y) at expected_version V"; unique per (tile, V) |
| **atom** | unit of client work in a job's DAG; content-addressed: `atom_hash = sha256(op ‖ algo_version ‖ sorted input sha256s ‖ params ‖ seed)` |
| **area** | polygon with owner; grants and proposals hang off it |
| **SAN** | catalog number `S`+base32(sha256(canonical GLB))[:12], with `canon_version` |
| **canonical GLB** | `canon-v1` (`client/lib/canon.js`): the scene graph flattened into world space, re-centred on the bottom centre of its bounding box, attributes quantised and sorted, one scene/node/mesh/buffer, JSON keys sorted, every extension but `KHR_materials_*` dropped, textures over 2048 px shrunk. Two exporters' files of the same model reduce to the same bytes, and therefore the same SAN. |

## 2. Tile frame & LOD

Web-Mercator ZXY. Two coordinate systems exist, defined once: `world_srid()` (what every geometry column stores, read off the schema) and `tile_srid()` (the ZXY grid and every ground raster), in `db/0056_crs.sql`; `server/splatworld/crs.py` and `client/lib/crs.js` repeat them for code that runs without the database, and a test in each refuses an EPSG code spelled anywhere else. `tile_bbox()` gives a tile in the world SRID, `tile_bbox_merc()` in the tile SRID.

Local frame per tile: origin = tile centre at DEM height, X east, Y up, Z south, metres, float32. Manifest gives `origin {lon,lat,h}`; viewer places entity relative to a floating origin (rebase every 5 km).

| z | edge @46°N | source | budget |
|---|---|---|---|
| 18 | ~110 m | trained from assembled scene (120 views) | 2.0 M |
| 16 | ~440 m | trained (45 views, the stations of z16-v2) | 600 k |
| 14 | 1.7 km | trained from the same stations (45 views) | 800 k |
| 12…6 | 6.7 km … 450 km | `merge` of 16 children (z+2), deterministic | 900 k … 1.5 M |

`area.detail` (10…18) = deepest zoom compiled inside that area. Default 14 (baseline). Raising it just dirties deeper tiles.

## 3. Schema (begun in `db/0001_schema.sql`; later migrations add to it — the core tables below, not every column)

```sql
artifact(sha256 text PK, kind text, bytes bigint, algo_version text, created_by uuid, created_at)
account(id uuid PK, owner_id uuid)                 -- owner_id = auth user; system accounts owner_id null
ledger(id bigserial, at, debit uuid, credit uuid, amount numeric(18,6), ref text UNIQUE)  -- append-only
area(id, geom geometry(Polygon,4326), owner_id, detail smallint, rules jsonb, created_at)
grant_(area_id, grantee_id, right_ text CHECK IN ('direct_edit','edit','approve'), PK(area_id,grantee_id,right_))
feature(id, area_id, kind → kind(name), geom geometry(GeometryZ,4326), props jsonb, rev bigint, deleted_at)
  -- kind is an OSM key since db/0157: highway, railway, aerialway, barrier,
  -- waterway, building, landuse, natural, natural_point (+ terrainmod).
  -- Which one it is is a property of the same name: landuse=forest.
instance(id, area_id, san, lon, lat, h, yaw, pitch, roll, scale, props jsonb, rev bigint, deleted_at)
proposal(id, area_id, author_id, state, diff jsonb, created_at)
approval(proposal_id, reviewer_id, at, PK(proposal_id,reviewer_id))
asset(san text PK, sha256 → artifact, canon_version smallint, name, category, bbox jsonb, tris int,
      tex_bytes int, license text CHECK IN ('cc0','free','paid','limited'), price numeric,
      editions int, issued int DEFAULT 0, creator_id, created_at)
asset_right(san, holder_id, acquired_at, ref, PK(san,holder_id))
tile(z,x,y PK, dirty bool, expected_version bigint, published_version bigint, sog_sha256 → artifact,
     manifest jsonb, published_at, published_by)
job(id, z,x,y, target_version, bounty numeric, state CHECK IN ('open','done','cancelled'), UNIQUE(z,x,y,target_version))
atom(id, job_id, atom_hash text UNIQUE, op, algo_version, deps bigint[], inputs jsonb, params jsonb, seed int,
     state CHECK IN ('waiting','ready','claimed','submitted','verified','failed'),
     worker_id, claimed_at, heartbeat_at, result jsonb, output_sha256, attempts smallint)
worker(id, user_id, caps jsonb, trust numeric DEFAULT 0.5, last_seen)
worker_op_stats(worker_id, op, ok int, bad int, PK(worker_id,op))
verification(atom_id, verifier_worker_id, kind CHECK IN ('structural','hash','perceptual'), passed bool, metrics jsonb, at)
elx_plugin(id text PK, name, xml_sha256 → artifact, source CHECK IN ('bundled','runner'), seen_at)
flow(id uuid PK, area_id → area, name, elx_sha256 → artifact, layout jsonb, rev bigint,
     created_by, updated_at, deleted_at, UNIQUE(area_id, name) WHERE deleted_at IS NULL)
```

Balance = `SUM(credit)-SUM(debit)` view. No mutable balances.

## 4. RPC (SECURITY DEFINER functions, exposed by PostgREST)

| rpc | rule |
|---|---|
| `login(email, pw) → jwt` | pgcrypto |
| `ensure_job(z,x,y) → job_id` | idempotent per `(tile, expected_version)`; builds atom DAG; caller must own/have grant on an area intersecting the tile, or attach a bounty |
| `set_bounty(job_id, amount)` | escrow: ledger debit caller → escrow account, ref `bounty:{job}` |
| `claim_atom(caps) → atom` | `FOR UPDATE SKIP LOCKED` over `state='ready'` and caps satisfied; sets `claimed`, records worker; also reserves the upload path `/jobs/{atom_id}/`. Refuses an op the worker is not trusted enough for (`train` ≥ 0.3, `verify` ≥ 0.6) and a `verify` of a tile this worker trained, encoded or has already judged |
| `heartbeat(atom_id)` | 5 min timeout → back to `ready`, `attempts++`; 3 → `failed` |
| `submit_atom(atom_id, output_sha256, result)` | runs **structural checks** (bytes > 0, counts within budget, bbox inside tile+margin, finite flags in result); for `merge` compares to any existing atom with same `atom_hash` (hash verification); state → `submitted` or `verified` |
| `submit_verification(atom_id, passed, metrics, spot)` | perceptual, about a published `sog` (spot checks since `build_dag` stopped making `verify` atoms, §8); a fail marks the tile `suspect` and costs the trainer trust |
| `submit_area(area, note) / approve_submission(id, price) / refuse_submission(id, note)` | a land's changed tiles, asked for as one submission; approval opens the jobs (`db/0068`–`0070`, `0109`) |
| `spot_due(z,x,y,days) → (kind, atom_id, inputs, params)` | what checking this tile again would consist of, for a tab that did not publish it, may write an area it touches, and has not checked it lately; nothing otherwise |
| `recheck_atom(atom_id)` | puts a settled deterministic atom back in the pool with its answer still on it, so the next claimant's answer is compared to it |
| `publish_tile(z,x,y, target_version, sog_sha256, manifest)` | **CAS**: `WHERE expected_version = target_version AND published_version < target_version`; releases escrow to workers pro rata by `result.gpu_seconds`; marks parent `dirty`, bumps parent `expected_version` |
| `can_write(path, sha256, bytes)` | called by nginx `auth_request`: path must be a reserved `/jobs/{atom}/…` for the claimant, or `/assets/{sha}` for an authenticated user; sha not yet present |
| `register_artifact(sha256, kind, bytes, algo_version)` | after successful PUT |
| `register_asset(sha256, canon_version, meta)` | derives SAN, no-op if exists |
| `buy_asset(san)` | `UPDATE asset SET issued = issued+1 WHERE issued < editions RETURNING` + ledger + `asset_right`, ref `buy:{san}:{user}` |
| `pay(to_account, amount, ref)` | generic transfer |
| `propose / approve / merge_proposal` | per `area.rules.required_approvals` |
| `save_flow(id, area, name, elx_sha256, layout, rev)` | **CAS** on `flow.rev`; the caller must build on the land; the sha must already be an artifact of kind `flow`. The ELX is the file, `layout` is beside it and never inside it |
| `delete_flow(id, rev)` | soft-deletes the pointer for everybody on the land; the immutable ELX stays |
| `bundle_plugins(plugins)` | admin: records which block set this world saw, by id and hash |

Triggers: `feature`/`instance` insert/update → for every materialised tile intersecting the row's geometry up to `area.detail`: `dirty = true`, `expected_version = expected_version + 1`. Nothing else.

## 5. Atom DAG

`build_dag` (latest in `db/0195_eachplacehasonetile.sql`) makes one of two
shapes. A leaf tile (`is_leaf_tile`: the deepest zoom compiled there, z14 at
the least) is trained; every coarser tile is merged from its sixteen children:
```
leaf:    dataset ─▶ train ─▶ sog ─▶ publish
coarser: merge   ─▶ sog ─▶ publish        (merge and sog hash-checked, Invariant 7)
```
`dataset` assembles the tile, draws every view of its camera set and writes one
tar — scene, meshes, seed, height, colliders, frames, `transforms.json`. One
folder holds everything the trainer learned from (`tools/dataset.mjs` unpacks
it for brush's own app). Before FND.5 it was `assemble ─▶ frame[0..N)`; both
modules remain, called by `dataset`.

Atoms become `ready` when all `deps` are `verified`. Inputs to each atom are artifact hashes reserved at `ensure_job` time (children's current `sog_sha256`, DEM/ortho tile hashes, GLB hashes, features/instances snapshot hash) so the whole job is reproducible from its `target_version`. `algo_current(op)` names the version every open job is rebuilt at; a migration that bumps one rebuilds every open job.

Nothing is rendered that a person has not approved: a land's changes are
submitted (`submit_area`) and approved or refused (`db/0068`, `db/0069`) before
any job opens, and the `sog` a tab uploads publishes as it lands
(`publish_sog`, the compare-and-swap of Invariant 3). A published tile makes
its parent stale and opens the parent's rebuild (`db/0070`).

Invariant 2, refined: a tile's snapshot pins the **symbol version** and the
**cover-mapping version** it was built with, instead of one digest over the
whole rule table. An admin's unsaved or unapplied symbol never reaches a
published tile; "apply to world" is what moves the pin.

## 6. Client atoms (`client/atoms/*.js`, run in a Worker + OffscreenCanvas)

The version each file writes is its `ALGO` export; the one a job asks for is
`algo_current()` in the database. Each file's header says what every version
changed.

| op | inputs | output | now |
|---|---|---|---|
| `dataset` | features+instances snapshot, the ground cut one zoom deeper, GLBs, camera set, frame size | one tar: assembled scene and meshes, seed `init.ply`, `height.r16`, `colliders.json`, WebP frames, `transforms.json` | `dataset-v8` over `assemble-v17` and `frame-v11`: terrain grid and skirt, terrainmods, road cuts, extruded footprints, seeded scatter, GLB placement; frames rasterised, or path traced where the operator asks (`splatworld.renderer`, db/0119), under the one sky of `lib/light.js` |
| `train` | the dataset tar, budget, iters, brush's settings | `.ply` + the tile's height and colliders, one tar | `train-v22`: brush (vendored wasm, `client/lib/brush.js`, built by `tools/build-brush.sh`) on WebGPU, given the dataset as a nerfstudio folder in the tab's own storage |
| `merge` | 16 child `.sog`s, voxel, budget | `.ply` | `merge-v1`, bit-exact deterministic (integer voxel keys, fixed iteration order, no atomics) |
| `sog` | `.ply` | one `.sog` per level + `lod` json (+ `cover` png) | `sog-v3`: levels ordered and written one file each for PlayCanvas's octree LOD (`client/lib/lodorder.js`) |
| `verify` | `.sog`, frames, held-out poses | `{psnr, passed}`, no artifact | `verify-v1`; only a spot check asks for it now (§8) |

There is no `sample` op any more: every leaf tile is trained.

Capability filter at claim: `train` needs `webgpu` and a `maxBufferSize` at least as big as its widest per-splat array (`min_buffer_mb` = 96 bytes a splat of the budget, db/0195). Everything else runs on WebGL2.

## 7. Files (nginx, or the `splatworld` server)

```
/assets/{sha}.glb   /assets/{sha}.webp
/tiles/{z}/{x}/{y}/{sha}.sog      manifest lives in tile.manifest (DB), not a file
/jobs/{atom_id}/{sha}             intermediate artifacts, GC after job done + 7 d
/geo/dem/{z}/{x}/{y}.r16   /geo/albedo/{z}/{x}/{y}.png   /geo/shade/{z}/{x}/{y}.png   cut on first request from the ground layers (db/0106)
```
`PUT` allowed only where `can_write` says yes; `Cache-Control: immutable` everywhere.

## 8. Verification model (explicit)

- structural: server-side in `submit_atom` — cheap, rejects garbage.
- deterministic: `merge`/`sog` — output hash must equal any prior result for the same `atom_hash`; `recheck_atom` puts a settled one back in the pool so the next claimant's answer is compared to it (Invariant 7).
- a person: nothing is rendered before the land's owner, or somebody they granted `approve`, approves the submission (`db/0044`, `db/0068`). This replaced the three trust-gated `verify` atoms as the publish gate; `build_dag` has made none since.
- perceptual, after the fact: a tab standing on a published tile it did not make is offered a spot check (`spot_due`, `client/js/spot.js`) — render poses the trainer never fitted, report PSNR. A failed spot check marks the tile `suspect`. This is probabilistic QA, not proof (Invariant 8).
- trust: scalar per worker, stats per op recorded. `claim_atom` refuses `train` below 0.3; a deterministic disagreement costs both sides.

## 9. Not in v1

Realtime multiplayer, taxes, tiers, leaderboards, server-side compute, Redis/queues/Node API, blockchain.

Route movers are in: a mover is a route, a speed and a timetable, and every
browser works out where the thing is from the world clock. Nothing is sent per
frame, so this is not the realtime multiplayer that stays out.
