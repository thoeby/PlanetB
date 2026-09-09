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

import { fetchJson } from '../js/api.js';
import { bboxOf, readPly } from '../lib/ply.js';
import { encodeSog } from '../lib/sogenc.js';
import { readTar } from '../lib/tar.js';
import { sha256 } from '../lib/hash.js';
import { localFromLonLat, tileBbox, tileCenter } from '../lib/tilemath.js';

export const ALGO = 'sog-v1';

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

export async function run({ atom, inputs, canvas, log, apiUrl }) {
    if (!inputs?.ply) throw new Error('sog needs a ply');
    const { splats: f, extra } = unpack(inputs.ply);
    const budget = Number(atom.params?.budget) || Infinity;
    if (f.count > budget) {
        throw new Error(`${f.count} splats is over the tile's budget of ${budget}`);
    }
    const tile = await jobTile(apiUrl, atom.job_id);
    const src = await sourceResult(apiUrl, atom.inputs?.ply);
    const origin = src.origin ?? { ...tileCenter(tile.z, tile.x, tile.y), h: 0 };

    const { bytes } = await encodeSog(f, canvas);
    log?.({ event: 'sogged', tile, splats: f.count, bytes: bytes.length });
    const dir = `/tiles/${tile.z}/${tile.x}/${tile.y}`;
    const manifest = manifestOf(tile, origin, f.count, bytes.length);
    const files = [{ ext: 'sog', kind: 'sog', algo_version: ALGO, bytes, dir }];
    const ground = extra.get('height.r16');
    const boxes = extra.get('colliders.json');
    if (ground && boxes) {
        const scene = JSON.parse(new TextDecoder().decode(extra.get('scene.json')));
        files.push({ ext: 'r16', kind: 'height', algo_version: 'assemble-v1',
            bytes: ground, dir });
        files.push({ ext: 'json', kind: 'colliders', algo_version: 'assemble-v1',
            bytes: boxes, dir });
        manifest.height = { sha256: await sha256(ground), ...scene.height };
        manifest.colliders = {
            sha256: await sha256(boxes),
            count: JSON.parse(new TextDecoder().decode(boxes)).boxes.length,
        };
    }
    return {
        files,
        output: 'sog',
        result: {
            bytes: bytes.length, splat_count: f.count, finite: true, bbox: bboxOf(f),
            tile, manifest, target_version: tile.target_version,
        },
    };
}
