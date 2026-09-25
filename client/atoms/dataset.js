// dataset.js — `dataset-v8` (ALGO below; each version's change is noted in this
// header). One tile, one folder: everything the trainer
// learns a tile from, made in one piece of work.
//
// Until FND.5 a tile was assembled by one atom and framed by three to six
// more, twenty views each, and the only place its frames, poses and seed were
// ever one nerfstudio dataset was the tab's private storage while brush ran.
// A job was eight folders in the store, and nothing on disk was the dataset.
//
// This atom assembles the tile (client/atoms/assemble.js), draws every view of
// its camera set (client/atoms/frame.js), and writes one tar: the assembled
// scene and its meshes, the seed, the height and colliders the player walks
// on, every frame, and the transforms.json that places them. train reads it,
// sog reads it for the tile's height and colliders, and tools/dataset.mjs
// unpacks it into the folder brush's own app takes. v2 draws both faces of
// every surface (client/lib/raster.js). v3 is assemble-v12 underneath: the
// ground mottled (client/lib/terrain.js mottleAt), init.ply the trainer's own
// seed (client/lib/sampling.js seedOf), and transforms.json naming it. v4 is
// assemble-v13 (the ground cut one zoom deeper, over a mesh twice as fine)
// and the frames drawn with a grain on the ground (client/lib/raster.js). v5
// is assemble-v14 (the ground from z16 for a z14 tile, over a mesh of 2049)
// and 1280 px frames (db/0188). v6 is assemble-v15: the ground runs three
// metres past the tile's edge (client/lib/skirt.js, db/0192). v7 is
// assemble-v16: a skirt that builds no walls (db/0194). v8 is assemble-v17:
// the edge heights carried out to the edge (db/0195). v9 is assemble-v18:
// no part with a role is baked (db/0200).
import { run as assemble } from './assemble.js';
import { renderFrames } from './frame.js';
import { readTar, writeTar } from '../lib/tar.js';

export const ALGO = 'dataset-v9';

export async function run(ctx) {
    const { atom, canvas, log } = ctx;
    const built = await assemble(ctx);
    const scene = built.files[0].bytes;
    const { entries, transforms, set, size } =
        await renderFrames({ atom, assemble: scene, canvas, log });
    const tar = writeTar([
        ...[...readTar(scene)].map(([name, bytes]) => ({ name, bytes })),
        ...entries,
        { name: 'transforms.json',
            bytes: new TextEncoder().encode(JSON.stringify(transforms)) },
    ]);
    log?.({ event: 'dataset', tile: atom.params, frames: entries.length, bytes: tar.length });
    return {
        files: [{ ext: 'tar', kind: 'dataset', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            ...built.result, bytes: tar.length,
            frames: entries.length, camera_set: set, size,
        },
    };
}
