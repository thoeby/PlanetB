#!/usr/bin/env node
// WP1.2 — synthetic test tiles. Builds coloured terrain-like splat blobs for a
// 2x2 block of z10 tiles, walks them through the real job/atom pipeline as an
// admin worker, and publishes them. Nothing here is a shortcut around the
// database: the sog is uploaded to the path can_write() reserved for the sog
// atom's holder, and publish_tile still does its compare-and-swap.
//
//     set -a; . ./.env; set +a; bash tools/test-tiles.sh
//
// The 2x2 block straddles a z8 boundary on purpose, so the four z10 tiles have
// two different z8 parents and one shared z6 grandparent: 4 + 2 + 1 = 7 tiles,
// and the streaming traversal in WP1.3 gets siblings that do not share a parent.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import * as api from '../client/js/api.js';
import * as tm from '../client/lib/tilemath.js';
import { packSog, unpackSog } from './sogwrite.mjs';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const FILES_URL = process.env.FILES_URL ?? 'http://localhost:8080';
const EMAIL = 'test-tiles@splatworld.local';
const PW = 'test-tiles-pw';

const Z10 = [[535, 361], [535, 362], [536, 361], [536, 362]];
const TILES = [
    ...Z10.map(([x, y]) => ({ z: 10, x, y })),
    { z: 8, x: 133, y: 90 }, { z: 8, x: 134, y: 90 },
    { z: 6, x: 33, y: 22 },
];
const GRID = { 6: 24, 8: 32, 10: 48 };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`ok - ${m}`); };
const no = (m) => { fail++; console.log(`not ok - ${m}`); };

const psql = (sql) => execFileSync('psql',
    ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A', '-c', sql],
    { encoding: 'utf8', env: process.env }).trim();

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// mulberry32 again: the same tiles come out on every machine and every run.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------- splat blobs

// A grid of gaussians over the tile, in the tile's own frame (X east, Y up,
// Z south, metres). Height and colour come from a few sines plus a couple of
// blobs, so a tile is recognisable when you fly over it and every zoom of the
// same ground looks like the same place.
function makeSplats(z, x, y) {
    const g = GRID[z];
    const n = g * g;
    const origin = tm.tileFrame(z, x, y, 0);
    const b = tm.tileBbox(z, x, y);
    const sw = tm.localFromLonLat(origin, b.west, b.south);
    const ne = tm.localFromLonLat(origin, b.east, b.north);
    const stepX = (ne.x - sw.x) / (g - 1);
    const stepZ = (sw.z - ne.z) / (g - 1);
    const relief = Math.max(20, (ne.x - sw.x) * 0.04);
    const r = rng(z * 1000003 + x * 1009 + y);
    const blobs = Array.from({ length: 3 }, () => ({
        u: r(), v: r(), rad: 0.12 + r() * 0.18,
        col: [0.3 + r() * 0.7, 0.3 + r() * 0.7, 0.3 + r() * 0.7],
    }));

    const f = { count: n };
    for (const k of ['x', 'y', 'z', 'r', 'g', 'b', 'a', 'sx', 'sy', 'sz',
        'qx', 'qy', 'qz', 'qw']) f[k] = new Float32Array(n);

    for (let j = 0; j < g; j++) {
        for (let i = 0; i < g; i++) {
            const k = j * g + i;
            const u = i / (g - 1), v = j / (g - 1);
            const h = relief * (Math.sin(u * 6.3 + z) * Math.cos(v * 4.1 - z)
                + 0.4 * Math.sin(u * 17 + v * 11));
            f.x[k] = sw.x + i * stepX;
            f.y[k] = h;
            f.z[k] = sw.z - j * stepZ;
            const t = h / relief * 0.5 + 0.5;
            let col = [0.25 + 0.5 * t, 0.45 + 0.35 * (1 - t), 0.2 + 0.3 * t];
            for (const blob of blobs) {
                const d = Math.hypot(u - blob.u, v - blob.v);
                if (d < blob.rad) col = blob.col;
            }
            [f.r[k], f.g[k], f.b[k]] = col;
            f.a[k] = 1;
            f.sx[k] = stepX * 0.6;
            f.sy[k] = relief * 0.05 + 0.5;
            f.sz[k] = stepZ * 0.6;
            f.qw[k] = 1;
        }
    }
    return { splats: f, origin };
}

const PLY_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SH_C0 = 0.28209479177387814;

// The merge atom's real output: the same gaussians as an uncompressed ply, in
// the field order the splat tooling uses. The sog is this, encoded.
function writePly(f) {
    const n = f.count;
    const head = Buffer.from('ply\nformat binary_little_endian 1.0\n'
        + `element vertex ${n}\n`
        + `${PLY_PROPS.map((p) => `property float ${p}\n`).join('')}`
        + 'end_header\n', 'ascii');
    const body = Buffer.alloc(n * PLY_PROPS.length * 4);
    for (let i = 0; i < n; i++) {
        const v = [f.x[i], f.y[i], f.z[i],
            (f.r[i] - 0.5) / SH_C0, (f.g[i] - 0.5) / SH_C0, (f.b[i] - 0.5) / SH_C0,
            20, Math.log(f.sx[i]), Math.log(f.sy[i]), Math.log(f.sz[i]),
            f.qw[i], f.qx[i], f.qy[i], f.qz[i]];
        for (let k = 0; k < v.length; k++) {
            body.writeFloatLE(v[k], (i * v.length + k) * 4);
        }
    }
    return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------- the world
//
// Areas and features are seeded over psql, not the API: no client role holds a
// write grant on `area` (db/0003_rls.sql), and this is the admin path that
// db/0008_admin.sql already establishes for the dev box.

function seedWorld() {
    const b0 = tm.tileBbox(10, Z10[0][0], Z10[0][1]);
    const b1 = tm.tileBbox(10, Z10[3][0], Z10[3][1]);
    const box = { west: b0.west, north: b0.north, east: b1.east, south: b1.south };
    // Inset so the feature cannot touch a neighbouring tile's edge: st_intersects
    // counts a touch, and the point of this block is that exactly 7 tiles dirty.
    const e = 1e-6;
    const ring = [
        [box.west + e, box.south + e], [box.east - e, box.south + e],
        [box.east - e, box.north - e], [box.west + e, box.north - e],
        [box.west + e, box.south + e],
    ].map(([lon, lat]) => `${lon} ${lat} 0`).join(', ');

    psql(`
        SET client_min_messages = warning;
        DO $$
        DECLARE
            uid uuid;
            aid uuid;
        BEGIN
            SELECT id INTO uid FROM auth.user WHERE email = '${EMAIL}';
            IF uid IS NULL THEN
                uid := register('${EMAIL}', '${PW}');
            END IF;
            UPDATE auth.user SET role = 'admin' WHERE id = uid;

            SELECT id INTO aid FROM area WHERE owner_id = uid;
            IF aid IS NULL THEN
                INSERT INTO area (geom, owner_id, detail)
                VALUES (st_makeenvelope(${box.west}, ${box.south},
                                        ${box.east}, ${box.north}, 4326), uid, 10)
                RETURNING id INTO aid;
            END IF;

            IF NOT EXISTS (SELECT 1 FROM feature WHERE area_id = aid) THEN
                INSERT INTO feature (area_id, kind, geom)
                VALUES (aid, 'forest',
                        st_geomfromtext('POLYGON Z ((${ring}))', 4326));
            END IF;
        END $$;`);
}

const tileRow = (t) => JSON.parse(psql(
    `SELECT coalesce(to_json(t), 'null') FROM tile t
     WHERE z = ${t.z} AND x = ${t.x} AND y = ${t.y}`));

// ----------------------------------------------------------------- the worker

async function putFile(path, bytes, sha) {
    const res = await fetch(FILES_URL + path, {
        method: 'PUT',
        headers: {
            'X-Sha256': sha,
            Authorization: `Bearer ${api.token()}`,
            'Content-Type': 'application/octet-stream',
        },
        body: bytes,
    });
    if (res.status !== 201 && res.status !== 204) {
        throw new Error(`PUT ${path} -> ${res.status} ${await res.text()}`);
    }
}

const CAPS = { webgpu: true, vram_gb: 8, algo: ['merge-v1', 'sog-v1'] };

// claim_atom picks globally: the next ready atom by bounty then id, and its
// expire_claims() can hand back work another run abandoned. Anything that is
// not this job's is parked and handed straight back — this tool cannot compute
// a stranger's atom, and silently letting the claim rot would cost that atom an
// attempt. The release is a psql write because no RPC un-claims an atom.
const parked = [];

async function claimFor(job) {
    for (;;) {
        const atom = await api.rpc('claim_atom', { caps: CAPS });
        if (!atom?.id) return null;
        if (atom.job_id === job) return atom;
        parked.push(atom.id);
    }
}

function releaseParked() {
    if (!parked.length) return;
    psql(`UPDATE atom SET state = 'ready', worker_id = NULL, claimed_at = NULL,
          heartbeat_at = NULL WHERE id IN (${parked.join(',')})`);
    console.log(`# handed back ${parked.length} atom(s) belonging to other jobs`);
    parked.length = 0;
}

async function runAtom(atom, t, art) {
    if (atom.op === 'merge') {
        await putFile(`/jobs/${atom.id}/merge.ply`, art.ply, art.plySha);
        await api.rpc('register_artifact', {
            sha256: art.plySha, kind: 'ply', bytes: art.ply.length,
            algo_version: 'merge-v1',
        });
        return api.rpc('submit_atom', {
            atom_id: atom.id, output_sha256: art.plySha,
            result: { splat_count: art.count, bytes: art.ply.length, gpu_seconds: 0.5 },
        });
    }
    if (atom.op === 'sog') {
        await putFile(`/tiles/${t.z}/${t.x}/${t.y}/${art.sogSha}.sog`,
            art.sog, art.sogSha);
        await api.rpc('register_artifact', {
            sha256: art.sogSha, kind: 'sog', bytes: art.sog.length,
            algo_version: 'sog-v1',
        });
        return api.rpc('submit_atom', {
            atom_id: atom.id, output_sha256: art.sogSha,
            result: { splat_count: art.count, bytes: art.sog.length, gpu_seconds: 0.5 },
        });
    }
    throw new Error(`unexpected op ${atom.op} at z${t.z} (merge and sog only below z16)`);
}

// The bundle is decoded again with the engine's own dequantisation before it is
// published: a .sog nobody can read is worse than no test tile at all. The
// bound is relative because means are stored as log(1+|p|), so precision is
// relative to the distance from the tile centre.
function checkRoundTrip(name, splats, bytes) {
    const back = unpackSog(bytes).splats;
    let dp = 0, dc = 0;
    for (let i = 0; i < splats.count; i++) {
        for (const k of ['x', 'y', 'z']) {
            dp = Math.max(dp, Math.abs(back[k][i] - splats[k][i]) / (1 + Math.abs(splats[k][i])));
        }
        for (const k of ['r', 'g', 'b']) {
            dc = Math.max(dc, Math.abs(back[k][i] - splats[k][i]));
        }
    }
    if (dp < 1e-3 && dc < 0.01) {
        ok(`${name} sog decodes back within ${dp.toExponential(1)} rel / ${dc.toFixed(4)} colour`);
    } else {
        no(`${name} sog round-trip is off by ${dp} rel / ${dc} colour`);
    }
}

async function compileTile(t) {
    const name = `${t.z}/${t.x}/${t.y}`;
    const row = tileRow(t);
    if (!row) throw new Error(`tile ${name} was never dirtied`);
    if (row.published_version === row.expected_version) {
        ok(`${name} already published at version ${row.published_version}`);
        return;
    }

    const { splats, origin } = makeSplats(t.z, t.x, t.y);
    const ply = writePly(splats);
    const sog = packSog(splats);
    checkRoundTrip(name, splats, sog.bytes);
    const art = {
        ply, sog: sog.bytes, count: splats.count,
        plySha: sha256(ply), sogSha: sha256(sog.bytes),
    };

    const job = await api.rpc('ensure_job', { z: t.z, x: t.x, y: t.y });
    for (;;) {
        const atom = await claimFor(job);
        if (!atom?.id) break;
        const state = await runAtom(atom, t, art);
        if (state !== 'verified') {
            throw new Error(`${name}: ${atom.op} atom ${atom.id} went ${state}`);
        }
    }

    // The manifest is the tile's whole description: nothing about a tile lives
    // in a file (ARCHITECTURE §2). geometric_error_m drives WP1.3's refinement.
    const b = tm.tileBbox(t.z, t.x, t.y);
    const span = tm.localFromLonLat(origin, b.east, b.north).x
        - tm.localFromLonLat(origin, b.west, b.north).x;
    const done = await api.rpc('publish_tile', {
        z: t.z, x: t.x, y: t.y,
        target_version: row.expected_version,
        sog_sha256: art.sogSha,
        manifest: {
            origin: { lon: origin.lon, lat: origin.lat, h: origin.h },
            splats: art.count,
            bytes: art.sog.length,
            geometric_error_m: span / GRID[t.z],
            algo_version: 'sog-v1',
        },
    });
    if (done) ok(`${name} published at version ${row.expected_version}`);
    else no(`${name} publish_tile returned false`);
}

async function main() {
    api.configure({ api: API_URL, files: FILES_URL });
    seedWorld();
    await api.login(EMAIL, PW);
    ok(`signed in as ${EMAIL} (${api.role()})`);

    // Bottom up: publishing a child dirties its parent and bumps the parent's
    // expected_version, so a parent's job may only be opened afterwards.
    try {
        for (const t of TILES) await compileTile(t);
    } finally {
        releaseParked();
    }

    for (const t of TILES) {
        const [row] = await api.select('tile', {
            z: `eq.${t.z}`, x: `eq.${t.x}`, y: `eq.${t.y}`,
            select: 'z,x,y,published_version,sog_sha256,manifest',
        });
        const good = row?.published_version > 0 && row.sog_sha256
            && Number.isFinite(row.manifest?.origin?.lon);
        if (good) ok(`GET /api/tile lists ${t.z}/${t.x}/${t.y} with a manifest`);
        else no(`GET /api/tile lists ${t.z}/${t.x}/${t.y} with a manifest`);
    }

    console.log(`# ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

await main();
