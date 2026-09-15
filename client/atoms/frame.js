// frame.js — `frame-v6`. The views `train` learns a tile from.
//
// One atom renders a range of a camera set (db/0005_jobs.sql chunks them at 20
// views), so a z18 job's 120 views spread across six tabs. Out comes a tar of
// WebP frames and the transforms.json that says where each was taken from, in
// nerfstudio's format and OpenGL's convention.
//
// frame-v1 rasterised the assembled mesh with one sun and no shadows. v2 and
// v3 path-traced it, which was seconds to minutes a frame and grain. v4 and
// v6 rasterise with three.js (client/lib/raster.js): soft shadow maps from
// the sun, the sky as an environment map, filmic tone mapping. v5 between
// them drew colours baked at assemble, for a sampled baseline and a ground
// mesh that no longer exist: every tile is trained from these frames now,
// so this is the world's one look. Every camera stands on the ground it is
// over (client/lib/cameras.js). Milliseconds a frame.

import { cameraSet, transformsJson, viewCount } from '../lib/cameras.js';
import { unpackMeshes } from '../lib/mesh.js';
import { DEFAULTS, Tracer } from '../lib/pathtrace.js';
import { Raster, meshObject } from '../lib/raster.js';
import { toWebp } from '../lib/render.js';
import { readTar, writeTar } from '../lib/tar.js';
import { localFromLonLat, tileBbox, tileFrame } from '../lib/tilemath.js';

export const ALGO = 'frame-v6';
export const SIZE = 1024;
const QUALITY = 0.9;

const name = (id) => `frame_${String(id).padStart(4, '0')}.webp`;

// The frames are square and 1024 px unless the atom says otherwise (the DAG
// sets 512 for z16, the size it is trained at; the browser gate sets less).
const sizeOf = (atom) => Math.max(16, Number(atom.params?.size) || SIZE);

// What the cameras have to see: the ground at the middle of the tile, and how
// far out the scene reaches.
export function boundsOf(meshes) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
        for (let i = 0; i < m.positions.length; i += 3) {
            for (let c = 0; c < 3; c++) {
                lo[c] = Math.min(lo[c], m.positions[i + c]);
                hi[c] = Math.max(hi[c], m.positions[i + c]);
            }
        }
    }
    return {
        centre: [(lo[0] + hi[0]) / 2, lo[1] + (hi[1] - lo[1]) * 0.1, (lo[2] + hi[2]) / 2],
        extent: Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2,
    };
}

// The ground `assemble` wrote (height.r16: uint16 rows, north-west first,
// over the tile's rectangle in its own frame), as a function of (x, z) in
// that frame, bilinear, clamped to the tile. The cameras stand on it.
export function groundOf(files, scene) {
    const raw = files.get('height.r16');
    const meta = scene.height;
    if (!raw || !meta?.size) return null;
    const data = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const { z, x, y } = scene.tile;
    const frame = tileFrame(z, x, y, scene.frame.h);
    const b = tileBbox(z, x, y);
    const sw = localFromLonLat(frame, b.west, b.south);
    const ne = localFromLonLat(frame, b.east, b.north);
    const n = meta.size;
    const span = meta.max - meta.min || 1;
    return (px, pz) => {
        const fu = Math.min(Math.max((px - sw.x) / (ne.x - sw.x) * (n - 1), 0), n - 1.0001);
        const fv = Math.min(Math.max((pz - ne.z) / (sw.z - ne.z) * (n - 1), 0), n - 1.0001);
        const i = Math.floor(fu); const j = Math.floor(fv);
        const su = fu - i; const sv = fv - j;
        const h = (k) => meta.min + data[k] / 65535 * span;
        return (h(j * n + i) * (1 - su) + h(j * n + i + 1) * su) * (1 - sv)
            + (h((j + 1) * n + i) * (1 - su) + h((j + 1) * n + i + 1) * su) * sv;
    };
}

// Which renderer draws the frames: the rasteriser, or — `renderer: 'trace'`
// in the atom's params (db/0107) — the path tracer, for global illumination
// at a few seconds a frame. Both take the same meshes and the same cameras.
function rendererOf(atom, canvas, size) {
    if (atom.params?.renderer !== 'trace') return new Raster(canvas, size);
    return new Tracer(canvas, size, {
        samples: Number(atom.params?.samples) || DEFAULTS.samples,
        bounces: Number(atom.params?.bounces) || DEFAULTS.bounces,
    });
}

export async function run({ atom, inputs, canvas, log }) {
    const set = atom.params.camera_set;
    const from = atom.params.from ?? 0;
    const to = Math.min(atom.params.to ?? viewCount(set), viewCount(set));
    if (!inputs?.assemble) throw new Error('frame needs the assemble artifact');
    const size = sizeOf(atom);

    const files = readTar(inputs.assemble);
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const cams = cameraSet(set, boundsOf(meshes), groundOf(files, scene)).slice(from, to);

    const raster = rendererOf(atom, canvas(size, size), size);
    for (const m of meshes) raster.add(meshObject(m, scene.materials));
    await raster.build(cams[0]);

    const entries = [];
    for (const cam of cams) {
        const rgba = await raster.draw(cam);
        entries.push({ name: name(cam.id), bytes: await toWebp(rgba, size, canvas, QUALITY) });
        log?.({ event: 'frame', pose: cam.id, done: entries.length, of: cams.length,
            picture: { webp: entries.at(-1).bytes } });
    }
    raster.dispose();
    log?.({ event: 'framed', set, from, to, size, tile: scene.tile });

    const transforms = transformsJson(cams, size, entries.map((e) => e.name));
    const tar = writeTar([
        ...entries,
        { name: 'transforms.json',
            bytes: new TextEncoder().encode(JSON.stringify(transforms)) },
    ]);
    return {
        files: [{ ext: 'tar', kind: 'frames', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, frames: entries.length, from, to, size,
            camera_set: set, finite: true, tile: scene.tile,
        },
    };
}
