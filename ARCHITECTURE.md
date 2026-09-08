# ARCHITECTURE.md — splatworld v3.1

```
  QGIS (admin) ── WFS-T ──▶ GeoServer ─────┐
  browser ─────── REST/JWT ─▶ PostgREST ───┼──▶ PostgreSQL + PostGIS
  browser ─────── GET / PUT ─▶ nginx ──────┘    /assets /tiles /jobs /geo (immutable files)
```

Four processes. All logic = SQL + client JS.

## 1. Concepts

| concept | definition |
|---|---|
| **artifact** | immutable file, addressed by `sha256`; kind ∈ glb, thumb, dem, ortho, frames, init_ply, ply, sog, height, colliders |
| **tile** | `(z,x,y)`, z ∈ {6,8,10,12,14,16,18}; has `expected_version` (world-input snapshot counter) and a pointer to its current published `sog` artifact |
| **world revision** | `feature.rev` / `instance.rev` monotonically increasing per row; a tile's `expected_version` bumps on any intersecting write |
| **job** | "compile tile (z,x,y) at expected_version V"; unique per (tile, V) |
| **atom** | unit of client work in a job's DAG; content-addressed: `atom_hash = sha256(op ‖ algo_version ‖ sorted input sha256s ‖ params ‖ seed)` |
| **area** | polygon with owner; grants and proposals hang off it |
| **SAN** | catalog number `S`+base32(sha256(canonical GLB))[:12], with `canon_version` |

## 2. Tile frame & LOD

Web-Mercator ZXY. Local frame per tile: origin = tile centre at DEM height, X east, Y up, Z south, metres, float32. Manifest gives `origin {lon,lat,h}`; viewer places entity relative to a floating origin (rebase every 5 km).

| z | edge @46°N | source | budget |
|---|---|---|---|
| 18 | ~110 m | trained from assembled scene (~120 views) | 2.0 M |
| 16 | ~440 m | trained (~56 views) | 600 k |
| 14 | 1.7 km | `sample` of the assembled scene, deterministic | 800 k |
| 12…6 | 6.7 km … 450 km | `merge` of 16 children (z+2), deterministic | 900 k … 1.5 M |

`area.detail` (10…18) = deepest zoom compiled inside that area. Default 14 (baseline). Raising it just dirties deeper tiles.

## 3. Schema (authoritative in `db/0001_schema.sql`)

```sql
artifact(sha256 text PK, kind text, bytes bigint, algo_version text, created_by uuid, created_at)
account(id uuid PK, owner_id uuid)                 -- owner_id = auth user; system accounts owner_id null
ledger(id bigserial, at, debit uuid, credit uuid, amount numeric(18,6), ref text UNIQUE)  -- append-only
area(id, geom geometry(Polygon,4326), owner_id, detail smallint, rules jsonb, created_at)
grant_(area_id, grantee_id, right_ text CHECK IN ('direct_edit','edit','approve'), PK(area_id,grantee_id,right_))
feature(id, area_id, kind, geom geometry(GeometryZ,4326), props jsonb, rev bigint, deleted_at)
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
| `submit_verification(atom_id, passed, metrics, spot)` | perceptual, about a `sog` atom; as many distinct workers as the job has `verify` atoms must pass → `verified`, and the tile publishes itself there and then (the encoder is long gone). Any fail → the trainer's stats and trust suffer and the training is done again, or, if the tile is already published, it is marked `suspect` |
| `spot_due(z,x,y,days) → (kind, atom_id, inputs, params)` | what checking this tile again would consist of, for a tab that did not publish it, may write an area it touches, and has not checked it lately; nothing otherwise |
| `recheck_atom(atom_id)` | puts a settled deterministic atom back in the pool with its answer still on it, so the next claimant's answer is compared to it |
| `publish_tile(z,x,y, target_version, sog_sha256, manifest)` | **CAS**: `WHERE expected_version = target_version AND published_version < target_version`; releases escrow to workers pro rata by `result.gpu_seconds`; marks parent `dirty`, bumps parent `expected_version` |
| `can_write(path, sha256, bytes)` | called by nginx `auth_request`: path must be a reserved `/jobs/{atom}/…` for the claimant, or `/assets/{sha}` for an authenticated user; sha not yet present |
| `register_artifact(sha256, kind, bytes, algo_version)` | after successful PUT |
| `register_asset(sha256, canon_version, meta)` | derives SAN, no-op if exists |
| `buy_asset(san)` | `UPDATE asset SET issued = issued+1 WHERE issued < editions RETURNING` + ledger + `asset_right`, ref `buy:{san}:{user}` |
| `pay(to_account, amount, ref)` | generic transfer |
| `propose / approve / merge_proposal` | per `area.rules.required_approvals` |

Triggers: `feature`/`instance` insert/update → for every materialised tile intersecting the row's geometry up to `area.detail`: `dirty = true`, `expected_version = expected_version + 1`. Nothing else.

## 5. Atom DAG

Trained tile (z16, z18):
```
assemble ─▶ frame[0..N) ─▶ train ─▶ sog ─▶ verify×3 ─▶ (published by the third verification)
```
Baseline tile (z14) — the floor every compiled area reaches, and not trained
(WP2.8's decision; `db/0016_sample.sql`):
```
assemble ─▶ sample ─▶ sog ─▶ (hash-verified in submit) ─▶ publish_tile
```
Merged tile (z ≤ 12):
```
merge ─▶ sog ─▶ (hash-verified in submit) ─▶ publish_tile
```
Atoms become `ready` when all `deps` are `verified`. Inputs to each atom are artifact hashes reserved at `ensure_job` time (children's current `sog_sha256`, DEM/ortho tile hashes, GLB hashes, features/instances snapshot hash) so the whole job is reproducible from its `target_version`.

## 6. Client atoms (`client/atoms/*.js`, run in a Worker + OffscreenCanvas)

| op | inputs | output | algo |
|---|---|---|---|
| `assemble` | features+instances snapshot (GeoJSON), DEM/ortho tiles, GLBs | `init.ply`, `height.r16`, `colliders.json` (one tar artifact) | `assemble-v1`: terrain grid, terrainmods, road cuts, extruded footprints, seeded scatter, GLB placement |
| `frame` | assemble artifact, camera set id, index range | WebP frames + `transforms.json` | `frame-v1` |
| `train` | frames, init.ply, budget, iters | `.ply` + the tile's height and colliders, in one tar | `train-v1`: Adam over a differentiable gaussian rasteriser (WebGPU, `client/lib/gsgpu.js`), poses injected from `transforms.json`, MCMC relocation and growth capped by the budget |
| `sample` | assemble artifact, budget | `.ply` + the tile's height and colliders, in one tar | `sample-v1`: the same area-weighted surface sampling that seeds a trained tile, at the tile's whole budget |
| `merge` | 16 child `.ply`/`.sog`, voxel, budget, seed | `.ply` | `merge-v1`, bit-exact deterministic (integer voxel keys, fixed iteration order, no atomics) |
| `sog` | `.ply` | `.sog` | `sog-v1` = splat-transform core |
| `verify` | `.sog`, the frame tars, 2 of the four held-out poses | `{psnr, passed}`, no artifact | `verify-v1` |

Capability filter at claim: `train` needs `webgpu && vram ≥ 4 GB` (z18) / `2 GB` (z16); everything else runs on WebGL2.

## 7. Files (nginx)

```
/assets/{sha}.glb   /assets/{sha}.webp
/tiles/{z}/{x}/{y}/{sha}.sog      manifest lives in tile.manifest (DB), not a file
/jobs/{atom_id}/{sha}             intermediate artifacts, GC after job done + 7 d
/geo/dem/{z}/{x}/{y}.r16   /geo/ortho/{z}/{x}/{y}.webp    pre-cut inputs, immutable per seed version
```
`PUT` allowed only where `can_write` says yes; `Cache-Control: immutable` everywhere.

## 8. Verification model (explicit)

- structural: server-side in `submit_atom` — cheap, rejects garbage.
- deterministic: `merge`/`sog` — output hash must equal any prior result for the same `atom_hash`; first result is accepted provisionally and re-computed by the next claimant of a `verify` atom if trust < 0.9.
- perceptual: `train` — 3 independent workers render 2 poses the trainer never fitted and report PSNR ≥ 22. This is probabilistic QA, not proof. Owner's own tab re-verifies its tiles on next visit (free spot check, `spot_due`); a failed spot check marks the tile `suspect`.
- trust: scalar per worker in v1, stats per op recorded for later. A perceptual pass is +0.05 to the trainer, a rejection −0.2, a deterministic disagreement −0.2 to both sides, and an accepted atom +0.01 — the last only so a new worker can reach the 0.6 a `verify` needs. A trainer at ≥ 0.95 is checked once instead of three times (`app.verify_min`).

## 9. Not in v1

Realtime multiplayer, taxes, tiers, leaderboards, server-side compute, Redis/queues/Node API, blockchain.
