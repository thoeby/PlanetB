// merge.js — `merge-v1`. Sixteen children into their parent, deterministically.
//
// Every tile at z <= 14 is this: the published .sog of its sixteen
// grandchildren at z+2, rotated and translated into the parent's own frame,
// clustered by integer voxel keys, and capped to the parent's budget.
//
// Invariant 7: the output must be bit-identical wherever it is computed. That
// rules out anything order-dependent — no atomics, no GPU reduction, no
// iteration over a hash map's insertion order. Children are walked in tile
// order, splats in file order, clusters in key order, and every sum is a double
// added in that same sequence.

import { bboxOf, emptySplats, writePly } from '../lib/ply.js';
import { decodeImage } from '../lib/geo.js';
import { decodeSog } from '../lib/sogenc.js';
import {
    enuRotation, localFromLonLat, matrixToQuaternion, tileBbox, tileCenter,
} from '../lib/tilemath.js';

export const ALGO = 'merge-v1';

// ------------------------------------------------------------------ children

async function childRows(apiUrl, z, x, y) {
    const cz = z + 2;
    const filter = [];
    for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
            filter.push(`and(z.eq.${cz},x.eq.${x * 4 + dx},y.eq.${y * 4 + dy})`);
        }
    }
    const url = `${apiUrl}/tile?select=z,x,y,sog_sha256,manifest&or=(${filter.join(',')})`;
    const rows = await fetch(url, { headers: { Accept: 'application/json' } })
        .then((r) => r.json());
    // Tile order, not the order the API happened to answer in.
    return rows.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

// The parent's frame: its centre, at the height its children stand on. A merged
// tile has no DEM of its own to ask — the seed only cuts the zooms it was told
// to — and every child origin is already on the ground.
function parentOrigin(z, x, y, rows) {
    const c = tileCenter(z, x, y);
    const hs = rows.map((r) => r.manifest?.origin?.h).filter(Number.isFinite);
    return { ...c, h: hs.length ? hs.reduce((s, v) => s + v, 0) / hs.length : 0 };
}

// A child's splats live in the child's frame; two frames a few kilometres apart
// are tilted relative to each other, so this is a rotation as well as an offset.
function transformOf(child, parent) {
    const m = enuRotation(child, parent);
    const t = localFromLonLat(parent, child.lon, child.lat, child.h);
    const [qx, qy, qz, qw] = matrixToQuaternion(m);
    return { m, t: [t.x, t.y, t.z], q: [qw, qx, qy, qz] };
}

const qmul = (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

// -------------------------------------------------------------------- voxels

const AXIS = 2 ** 17;          // 131072 cells an axis, so a key stays exact
const FIELDS = 16;             // w, p*3, c*4, s*3, bestW, bestQ is kept apart

export class Grid {
    constructor(voxel, origin) {
        this.voxel = voxel;
        this.origin = origin;
        this.index = new Map();
        this.data = new Float64Array(1024 * FIELDS);
        this.quat = new Float64Array(1024 * 4);
        this.keys = [];
    }

    slot(key) {
        const have = this.index.get(key);
        if (have !== undefined) return have;
        const at = this.keys.length;
        if ((at + 1) * FIELDS > this.data.length) {
            const grown = new Float64Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
            const q = new Float64Array(this.quat.length * 2);
            q.set(this.quat);
            this.quat = q;
        }
        this.index.set(key, at);
        this.keys.push(key);
        return at;
    }

    // p is already in the parent's frame.
    fold(p, colour, scale, quat, weight) {
        const k = this.key(p);
        const at = this.slot(k) * FIELDS;
        const d = this.data;
        d[at] += weight;
        for (let i = 0; i < 3; i++) d[at + 1 + i] += p[i] * weight;
        for (let i = 0; i < 4; i++) d[at + 4 + i] += colour[i] * weight;
        for (let i = 0; i < 3; i++) d[at + 8 + i] += scale[i] * weight;
        // The heaviest member decides the cluster's orientation: a mean of
        // quaternions is not a rotation, and picking one is reproducible.
        if (weight > d[at + 11]) {
            d[at + 11] = weight;
            for (let i = 0; i < 4; i++) this.quat[(at / FIELDS) * 4 + i] = quat[i];
        }
    }

    key(p) {
        let k = 0;
        for (let i = 0; i < 3; i++) {
            const c = Math.min(AXIS - 1, Math.max(0,
                Math.floor(p[i] / this.voxel) + AXIS / 2));
            k = k * AXIS + c;
        }
        return k;
    }

    // Weight decides what survives the budget, the key decides the order: two
    // machines keep the same splats and write them in the same sequence.
    finish(budget) {
        const order = this.keys.map((_, i) => i)
            .sort((a, b) => this.data[b * FIELDS] - this.data[a * FIELDS]
                || this.keys[a] - this.keys[b])
            .slice(0, budget)
            .sort((a, b) => this.keys[a] - this.keys[b]);
        const f = emptySplats(order.length);
        for (let n = 0; n < order.length; n++) {
            const at = order[n] * FIELDS;
            const w = this.data[at] || 1;
            f.x[n] = this.data[at + 1] / w;
            f.y[n] = this.data[at + 2] / w;
            f.z[n] = this.data[at + 3] / w;
            f.r[n] = this.data[at + 4] / w;
            f.g[n] = this.data[at + 5] / w;
            f.b[n] = this.data[at + 6] / w;
            f.a[n] = Math.min(1, this.data[at + 7] / w);
            // A cluster stands for everything in its voxel, so it is at least
            // half a voxel wide however small its members were.
            f.sx[n] = Math.max(this.data[at + 8] / w, this.voxel / 2);
            f.sy[n] = Math.max(this.data[at + 9] / w, this.voxel / 2);
            f.sz[n] = Math.max(this.data[at + 10] / w, this.voxel / 2);
            [f.qw[n], f.qx[n], f.qy[n], f.qz[n]] =
                [0, 1, 2, 3].map((i) => this.quat[order[n] * 4 + i]);
        }
        return f;
    }
}

function foldChild(grid, splats, tf) {
    const p = [0, 0, 0];
    for (let i = 0; i < splats.count; i++) {
        const v = [splats.x[i], splats.y[i], splats.z[i]];
        for (let r = 0; r < 3; r++) {
            p[r] = tf.m[r][0] * v[0] + tf.m[r][1] * v[1] + tf.m[r][2] * v[2] + tf.t[r];
        }
        const weight = splats.a[i] * (splats.sx[i] * splats.sz[i] + 1e-9);
        grid.fold(p, [splats.r[i], splats.g[i], splats.b[i], splats.a[i]],
            [splats.sx[i], splats.sy[i], splats.sz[i]],
            qmul(tf.q, [splats.qw[i], splats.qx[i], splats.qy[i], splats.qz[i]]),
            weight);
    }
}

// The parent's edge in metres, which is what its budget has to cover.
function tileEdge(z, x, y, origin) {
    const b = tileBbox(z, x, y);
    const sw = localFromLonLat(origin, b.west, b.south);
    const ne = localFromLonLat(origin, b.east, b.north);
    return Math.max(ne.x - sw.x, sw.z - ne.z);
}

// -------------------------------------------------------------------- atom

export async function run({ atom, inputs, canvas, log, apiUrl }) {
    const { z, x, y, budget } = atom.params;
    const rows = await childRows(apiUrl, z, x, y);
    const origin = parentOrigin(z, x, y, rows);
    // params.voxel is a floor, not the answer: clustering finer than the budget
    // can hold only makes work for the top-k that follows.
    const voxel = Math.max(atom.params.voxel ?? 0.05,
        tileEdge(z, x, y, origin) / Math.sqrt(budget));
    const grid = new Grid(voxel, origin);

    const bytesOf = new Map();
    (atom.inputs?.children ?? []).forEach((sha, i) => {
        if (sha) bytesOf.set(sha, inputs.children?.[i]);
    });
    const missing = [];
    const used = [];
    let taken = 0;
    for (const row of rows) {
        const bytes = row.sog_sha256 && bytesOf.get(row.sog_sha256);
        if (!bytes || !row.manifest?.origin) {
            missing.push(`${row.z}/${row.x}/${row.y}`);
            continue;
        }
        const { splats } = await decodeSog(bytes, (b) => decodeImage(b, canvas));
        foldChild(grid, splats, transformOf(row.manifest.origin, origin));
        used.push(`${row.z}/${row.x}/${row.y}`);
        taken += splats.count;
    }
    if (!taken) throw new Error(`no published child of ${z}/${x}/${y} to merge`);

    const f = grid.finish(budget);
    log?.({ event: 'merged', z, x, y, from: taken, clusters: grid.keys.length,
        kept: f.count, voxel });
    const bytes = writePly(f);
    return {
        files: [{ ext: 'ply', kind: 'ply', algo_version: ALGO, bytes }],
        output: 'ply',
        result: {
            bytes: bytes.length, splat_count: f.count, finite: true, bbox: bboxOf(f),
            voxel, origin, from: taken, clusters: grid.keys.length, used, missing,
        },
    };
}
