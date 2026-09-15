// frame.js — `frame-v4`. The views `train` learns a tile from.
//
// One atom renders a range of a camera set (db/0005_jobs.sql chunks them at 20
// views), so a z18 job's 120 views spread across six tabs. Out comes a tar of
// WebP frames and the transforms.json that says where each was taken from, in
// nerfstudio's format and OpenGL's convention.
//
// frame-v1 rasterised the assembled mesh with one sun and no shadows. v2 and
// v3 path-traced it, which was seconds to minutes a frame and grain. v4 is
// three.js rasterising (client/lib/raster.js): soft shadow maps from the sun,
// the sky as an environment map, filmic tone mapping, a detail texture on the
// ground, every placed asset with its own textures from the canonical GLB, and
// every camera standing on the ground it is over (client/lib/cameras.js).
// Milliseconds a frame.

import { loadAssets } from '../lib/assets.js';
import { cameraSet, transformsJson, viewCount } from '../lib/cameras.js';
import { unpackMeshes } from '../lib/mesh.js';
import { Raster, loadGlb, meshObject, placeObject, poseOf } from '../lib/raster.js';
import { toWebp } from '../lib/render.js';
import { readTar, writeTar } from '../lib/tar.js';
import { localFromLonLat, tileBbox, tileFrame } from '../lib/tilemath.js';

export const ALGO = 'frame-v4';
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

// The placed assets, textured, from their GLBs. If any asset is missing from
// the store the flat baked copies of all of them stay, so a frame never shows
// one asset twice or not at all.
async function placeAssets(raster, scene, filesUrl) {
    const instances = scene.instances ?? [];
    if (!instances.length) return { textured: 0, baked: true };
    const assets = await loadAssets(instances, { filesUrl });
    if (instances.some((i) => !assets.has(i.sha256))) return { textured: 0, baked: true };
    const { z, x, y } = scene.tile;
    const frame = tileFrame(z, x, y, scene.frame.h);
    const loaded = new Map();
    for (const inst of instances) {
        if (!loaded.has(inst.sha256)) {
            loaded.set(inst.sha256, await loadGlb(assets.get(inst.sha256)));
        }
        raster.add(placeObject(loaded.get(inst.sha256).clone(), poseOf(inst, frame)));
    }
    return { textured: instances.length, baked: false };
}

export async function run({ atom, inputs, canvas, log, filesUrl }) {
    const set = atom.params.camera_set;
    const from = atom.params.from ?? 0;
    const to = Math.min(atom.params.to ?? viewCount(set), viewCount(set));
    if (!inputs?.assemble) throw new Error('frame needs the assemble artifact');
    const size = sizeOf(atom);

    const files = readTar(inputs.assemble);
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const cams = cameraSet(set, boundsOf(meshes), groundOf(files, scene)).slice(from, to);

    const raster = new Raster(canvas(size, size), size);
    const assets = await placeAssets(raster, scene, filesUrl);
    for (const m of meshes) {
        if (assets.baked || m.material !== 'asset') {
            raster.add(meshObject(m, scene.materials, raster.detail));
        }
    }
    await raster.build(cams[0]);

    const entries = [];
    for (const cam of cams) {
        const rgba = raster.draw(cam);
        entries.push({ name: name(cam.id), bytes: await toWebp(rgba, size, canvas, QUALITY) });
        log?.({ event: 'frame', pose: cam.id, done: entries.length, of: cams.length,
            picture: { webp: entries.at(-1).bytes } });
    }
    raster.dispose();
    log?.({ event: 'framed', set, from, to, size, tile: scene.tile, textured: assets.textured });

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
            camera_set: set, finite: true, tile: scene.tile, textured: assets.textured,
        },
    };
}
