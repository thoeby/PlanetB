// dataset.js — the nerfstudio dataset brush trains a tile on, built from the
// tile's frame tars and its seed. Shared by client/atoms/train.js, which
// hands it to brush in the tab, and tools/dataset.mjs, which writes it to a
// folder so the same run can be repeated in brush's own app.
import { holdout } from './frames.js';
import { viewCount } from './cameras.js';
import { writePly } from './ply.js';
import { readTar } from './tar.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// The dataset brush reads: every frame that is not held out, one
// transforms.json naming them and the seed, and the seed itself.
// `without` leaves out every frame of those kinds ('ring', 'oblique',
// 'top'), for a run that asks what a kind of view does to the result.
export function dataset(tars, set, seed, { all = false, without = [] } = {}) {
    const back = new Set(all ? [] : holdout(viewCount(set) || 0));
    const files = [];
    let intr = null;
    const frames = [];
    for (const bytes of tars) {
        const t = readTar(bytes);
        const meta = JSON.parse(decoder.decode(t.get('transforms.json')));
        intr = intr ?? meta;
        for (const fr of meta.frames) {
            if (back.has(fr.pose_id) || without.includes(fr.kind)) continue;
            files.push({ name: fr.file_path, bytes: t.get(fr.file_path) });
            frames.push(fr);
        }
    }
    if (!frames.length) throw new Error('every frame was held out; the set is too small');
    frames.sort((a, b) => a.pose_id - b.pose_id);
    const transforms = { ...intr, frames, ply_file_path: 'init.ply' };
    files.push({ name: 'transforms.json', bytes: encoder.encode(JSON.stringify(transforms)) });
    files.push({ name: 'init.ply', bytes: writePly(seed) });
    return { files, views: frames.length, held: back.size };
}

