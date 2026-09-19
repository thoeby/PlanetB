// sog.js — `sog-v3`. The gaussians as the viewer streams them.
//
// The ply that comes out of `merge` or `train` is what a worker computed; the
// .sog is what a browser downloads: quantised, packed into five lossless WebP
// planes and zipped. It is written straight to the path the tile will serve it
// from — /tiles/{z}/{x}/{y}/{sha}.sog, which db/0011_tilefiles.sql reserves for
// whoever holds this atom — so publishing is a pointer update and nothing moves.
//
// The manifest the tile needs travels in the result: publish_tile takes it, and
// the origin comes from the atom that made the ply.

import { fetchJson } from '../js/api.js';
import { bboxOf, permute, prefixOf, readPly } from '../lib/ply.js';
import { cover, lodOrder } from '../lib/lodorder.js';
import { encodeSog } from '../lib/sogenc.js';
import { readTar } from '../lib/tar.js';
import { sha256 } from '../lib/hash.js';
import { localFromLonLat, tileBbox, tileCenter } from '../lib/tilemath.js';

export const ALGO = 'sog-v3';
// v3 writes one file per level rather than one file with prefixes in it. A
// level is a file, so a tile seen from far away fetches the coarse one — a
// fortieth of the bytes — instead of the whole tile to draw a fortieth of it.
// It costs about a third more storage, because a coarse level's splats are
// also in the fine level's file, and buys the thing prefixes could not: the
// levels bound what is *downloaded* and not only what is drawn.
//
// Each coarse level is also widened to the voxel its splats speak for
// (client/lib/lodorder.js cover): a quarter as many splats at the same size is
// a sieve, not a coarser tile.
//
// v2 ordered the splats so that every prefix of them is a fair sample of the
// tile (client/lib/lodorder.js) and wrote a second, tiny file saying where
// the useful prefixes end. The viewer hands that file to PlayCanvas's octree,
// which then draws as much of each tile as the whole scene's budget affords
// rather than all of every tile or none of it (PLAN-lod.md).
//
// It is done here and not in `train` because a merged tile never passes
// through the trainer: it comes out of `merge` in voxel-scan order, and a
// prefix of a scan order is a stripe of ground. Both producers pass through
// here, and re-sogging a tile costs seconds where retraining costs GPU-minutes.

// `merge` hands over a bare ply; `sample` hands over a tar, because a baseline
// tile also carries the ground the player walks on and the boxes they bump
// into. Both land beside the .sog under the same authority
// (db/0011_tilefiles.sql), so a published tile is complete.
function unpack(bytes) {
    const head = new TextDecoder('ascii').decode(new Uint8Array(bytes).subarray(0, 3));
    if (head === 'ply') return { splats: readPly(bytes), extra: new Map() };
    const files = readTar(bytes);
    const ply = files.get('splats.ply') ?? files.get('init.ply');
    if (!ply) throw new Error('the artifact holds no ply for the sog to encode');
    return { splats: readPly(ply), extra: files };
}

async function jobTile(apiUrl, jobId) {
    const [job] = await fetchJson(`${apiUrl}/job?id=eq.${jobId}&select=z,x,y,target_version`);
    if (!job) throw new Error(`no job ${jobId} to place this sog under`);
    return job;
}

// What the ply's own atom recorded: chiefly the frame its positions are in.
async function sourceResult(apiUrl, id) {
    if (!Number.isFinite(id)) return {};
    const [row] = await fetchJson(`${apiUrl}/atom?id=eq.${id}&select=result`);
    return row?.result ?? {};
}

// The size of the smallest thing this tile can show, which is what the
// streamer's screen-space error is measured against (client/js/tiles.js).
function manifestOf(tile, origin, splats, bytes) {
    const b = tileBbox(tile.z, tile.x, tile.y);
    const span = localFromLonLat(origin, b.east, b.north).x
        - localFromLonLat(origin, b.west, b.north).x;
    return {
        origin: { lon: origin.lon, lat: origin.lat, h: origin.h },
        splats, bytes, algo_version: ALGO,
        geometric_error_m: span / Math.max(1, Math.sqrt(splats)),
    };
}

// What PlayCanvas's octree parser reads (framework/parsers/gsplat-octree.js):
// one file, one leaf, and a level per prefix. Level 0 is the finest — the
// engine sums it as the tile's splat count — and every level is `offset 0`,
// which is the prefix property in its vocabulary. No `errors`: with none given
// the engine derives them from the counts, `log(finest / count)`.
//
// The bound is rounded to centimetres before it is stringified. It is
// float-derived and this file is content-addressed, so rounding onto an
// integer grid means no argument about float formatting can give one tile two
// shas (Invariant 1).
export function lodMeta(shas, bbox, levels) {
    const cm = (v) => Math.round(v * 100) / 100;
    const lods = {};
    levels.forEach((level, i) => {
        lods[String(i)] = { file: i, offset: 0, count: level.count };
    });
    return {
        lodLevels: levels.length,
        filenames: shas.map((sha) => `${sha}.sog`),
        tree: {
            bound: { min: bbox.slice(0, 3).map(cm), max: bbox.slice(3).map(cm) },
            lods,
        },
    };
}

// What a tile carries besides its splats: the ground the player walks on, the
// boxes they bump into, and — since FND.13 — a picture of what the ground was
// drawn in, for the map and for QGIS. Each is published under the tile's own
// authority (db/0011_tilefiles.sql) and named in the manifest, so a published
// tile is complete.
async function alongside(extra, files, manifest, dir) {
    const drawn = extra.get('cover.png');
    if (drawn) {
        files.push({ ext: 'png', kind: 'cover', algo_version: ALGO, bytes: drawn, dir });
        manifest.cover = { sha256: await sha256(drawn), bytes: drawn.byteLength };
    }
    const ground = extra.get('height.r16');
    const boxes = extra.get('colliders.json');
    if (!ground || !boxes) return;
    const scene = JSON.parse(new TextDecoder().decode(extra.get('scene.json')));
    files.push({ ext: 'r16', kind: 'height', algo_version: 'assemble-v3',
        bytes: ground, dir });
    files.push({ ext: 'json', kind: 'colliders', algo_version: 'assemble-v3',
        bytes: boxes, dir });
    manifest.height = { sha256: await sha256(ground), ...scene.height };
    manifest.colliders = {
        sha256: await sha256(boxes),
        count: JSON.parse(new TextDecoder().decode(boxes)).boxes.length,
    };
}

export async function run({ atom, inputs, canvas, log, apiUrl }) {
    if (!inputs?.ply) throw new Error('sog needs a ply');
    const { splats: f, extra } = unpack(inputs.ply);
    const budget = Number(atom.params?.budget) || Infinity;
    if (!f.count) {
        throw new Error('the ply holds no splats: nothing to encode (the atom that made it'
            + ' sampled or trained an empty tile)');
    }
    if (f.count > budget) {
        throw new Error(`${f.count} splats is over the tile's budget of ${budget}`);
    }
    const tile = await jobTile(apiUrl, atom.job_id);
    const src = await sourceResult(apiUrl, atom.inputs?.ply);
    const origin = src.origin ?? { ...tileCenter(tile.z, tile.x, tile.y), h: 0 };

    // The order is the levels: level i is the first n splats of it, and the
    // encoder writes splat i to texel i (client/lib/sogenc.js fillPlanes), so
    // a level is a file that holds exactly its own splats.
    const { order, levels } = lodOrder(f);
    const s = permute(f, order);
    const dir = `/tiles/${tile.z}/${tile.x}/${tile.y}`;
    const files = [];
    const shas = [];
    let bytes = null;
    for (const [i, level] of levels.entries()) {
        const part = i === 0 ? s : cover(prefixOf(s, level.count), level.cell / 2);
        const out = await encodeSog(part, canvas);
        if (i === 0) bytes = out.bytes;
        shas.push(await sha256(out.bytes));
        files.push({ ext: 'sog', kind: 'sog', algo_version: ALGO, bytes: out.bytes, dir });
    }
    log?.({ event: 'sogged', tile, splats: s.count, bytes: bytes.length,
        levels: levels.map((l) => l.count) });
    const manifest = manifestOf(tile, origin, s.count, bytes.length);
    const meta = new TextEncoder().encode(JSON.stringify(lodMeta(shas, bboxOf(s), levels)));
    files.push({ ext: 'json', kind: 'lod', algo_version: ALGO, bytes: meta, dir });
    manifest.lod = { sha256: await sha256(meta), levels: levels.map((l) => l.count),
        files: shas };
    await alongside(extra, files, manifest, dir);
    return {
        files,
        output: 'sog',
        result: {
            bytes: bytes.length, splat_count: s.count, finite: true, bbox: bboxOf(s),
            tile, manifest, target_version: tile.target_version,
        },
    };
}
