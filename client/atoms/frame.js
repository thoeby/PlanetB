// frame.js — `frame-v1`. The views `train` learns a tile from.
//
// One atom renders a range of a camera set (db/0005_jobs.sql chunks them at 20
// views), so a z18 job's 120 views spread across six tabs. Out comes a tar of
// WebP frames and the transforms.json that says where each was taken from, in
// nerfstudio's format and OpenGL's convention.

import { cameraSet, transformsJson, viewCount } from '../lib/cameras.js';
import { unpackMeshes } from '../lib/mesh.js';
import { Renderer, toWebp } from '../lib/render.js';
import { readTar, writeTar } from '../lib/tar.js';

export const ALGO = 'frame-v1';
export const SIZE = 1024;
const QUALITY = 0.9;

const name = (id) => `frame_${String(id).padStart(4, '0')}.webp`;

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

export async function run({ atom, inputs, canvas, log }) {
    const set = atom.params.camera_set;
    const from = atom.params.from ?? 0;
    const to = Math.min(atom.params.to ?? viewCount(set), viewCount(set));
    if (!inputs?.assemble) throw new Error('frame needs the assemble artifact');

    const files = readTar(inputs.assemble);
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const cams = cameraSet(set, boundsOf(meshes)).slice(from, to);

    const renderer = new Renderer(canvas(SIZE, SIZE), SIZE);
    renderer.upload(meshes);

    const entries = [];
    for (const cam of cams) {
        const rgba = renderer.draw(cam);
        entries.push({ name: name(cam.id), bytes: await toWebp(rgba, SIZE, canvas, QUALITY) });
    }
    log?.({ event: 'framed', set, from, to, tile: scene.tile });

    const transforms = transformsJson(cams, SIZE, entries.map((e) => e.name));
    const tar = writeTar([
        ...entries,
        { name: 'transforms.json',
            bytes: new TextEncoder().encode(JSON.stringify(transforms)) },
    ]);
    return {
        files: [{ ext: 'tar', kind: 'frames', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, frames: entries.length, from, to,
            camera_set: set, finite: true, tile: scene.tile,
        },
    };
}
