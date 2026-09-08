// sog.js — `sog-v1`. The gaussians as the viewer streams them.
//
// The ply that comes out of `merge` or `train` is what a worker computed; the
// .sog is what a browser downloads: quantised, packed into five lossless WebP
// planes and zipped. It is written straight to the path the tile will serve it
// from — /tiles/{z}/{x}/{y}/{sha}.sog, which db/0011_tilefiles.sql reserves for
// whoever holds this atom — so publishing is a pointer update and nothing moves.
//
// The manifest the tile needs travels in the result: publish_tile takes it, and
// the origin comes from the atom that made the ply.

import { bboxOf, readPly } from '../lib/ply.js';
import { encodeSog } from '../lib/sogenc.js';
import { localFromLonLat, tileBbox, tileCenter } from '../lib/tilemath.js';

export const ALGO = 'sog-v1';

async function jobTile(apiUrl, jobId) {
    const [job] = await fetch(`${apiUrl}/job?id=eq.${jobId}&select=z,x,y,target_version`,
        { headers: { Accept: 'application/json' } }).then((r) => r.json());
    if (!job) throw new Error(`no job ${jobId} to place this sog under`);
    return job;
}

// What the ply's own atom recorded: chiefly the frame its positions are in.
async function sourceResult(apiUrl, id) {
    if (!Number.isFinite(id)) return {};
    const [row] = await fetch(`${apiUrl}/atom?id=eq.${id}&select=result`,
        { headers: { Accept: 'application/json' } }).then((r) => r.json());
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

export async function run({ atom, inputs, canvas, log, apiUrl }) {
    if (!inputs?.ply) throw new Error('sog needs a ply');
    const f = readPly(inputs.ply);
    const budget = Number(atom.params?.budget) || Infinity;
    if (f.count > budget) {
        throw new Error(`${f.count} splats is over the tile's budget of ${budget}`);
    }
    const tile = await jobTile(apiUrl, atom.job_id);
    const src = await sourceResult(apiUrl, atom.inputs?.ply);
    const origin = src.origin ?? { ...tileCenter(tile.z, tile.x, tile.y), h: 0 };

    const { bytes } = await encodeSog(f, canvas);
    log?.({ event: 'sogged', tile, splats: f.count, bytes: bytes.length });
    const manifest = manifestOf(tile, origin, f.count, bytes.length);
    return {
        files: [{
            ext: 'sog', kind: 'sog', algo_version: ALGO, bytes,
            dir: `/tiles/${tile.z}/${tile.x}/${tile.y}`,
        }],
        output: 'sog',
        result: {
            bytes: bytes.length, splat_count: f.count, finite: true, bbox: bboxOf(f),
            tile, manifest, target_version: tile.target_version,
        },
    };
}
