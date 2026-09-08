// sample.js — `sample-v1`. The baseline tile, without training.
//
// A z14 tile is the world's floor: every area is compiled to at least that
// depth, and there are fourteen thousand of them in Switzerland alone. Training
// each one is not what the baseline is for, so this takes the scene `assemble`
// built and samples its surfaces at the tile's whole budget — the same
// area-weighted sampling that seeds a trained tile, kept as the answer.
//
// Out comes a tar: the splats, and the two files that make the tile walkable,
// carried through from `assemble` so the sog atom can put them beside the .sog.

import { rngOf, sampleSurfaces } from './assemble.js';
import { unpackMeshes } from '../lib/mesh.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { readTar, writeTar } from '../lib/tar.js';

export const ALGO = 'sample-v1';

export async function run({ atom, inputs, log }) {
    if (!inputs?.assemble) throw new Error('sample needs the assemble artifact');
    const files = readTar(inputs.assemble);
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const { z, x, y } = scene.tile;
    const budget = Number(atom.params?.budget) || scene.budget;

    const splats = sampleSurfaces(meshes, budget, rngOf(atom, z, x, y));
    log?.({ event: 'sampled', tile: scene.tile, splats: splats.count });
    const tar = writeTar([
        { name: 'splats.ply', bytes: writePly(splats) },
        { name: 'height.r16', bytes: files.get('height.r16') },
        { name: 'colliders.json', bytes: files.get('colliders.json') },
        { name: 'scene.json', bytes: files.get('scene.json') },
    ]);
    return {
        files: [{ ext: 'tar', kind: 'ply', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, splat_count: splats.count, finite: true,
            bbox: bboxOf(splats), origin: scene.origin, tile: scene.tile,
        },
    };
}
