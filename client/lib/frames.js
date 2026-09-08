// frames.js — the views a tile was rendered from, read back.
//
// `frame-v1` writes a tar of WebP frames and the transforms.json that says
// where each was taken from (client/lib/cameras.js). Both `train` and `verify`
// start from those tars, and they have to agree about what a frame is down to
// the pixel: the same size, the same filter, the same camera. That agreement
// lives here.
//
// Frames are stored at 1024 px and trained at 512: a quarter of the memory for
// 120 views, and the tile's own budget is what limits its detail long before
// the frames do. The reduction is a box filter in plain JS rather than the
// browser's resampler, because two workers must get the same bytes.

import { cameraFrom } from './gsmath.js';
import { readTar } from './tar.js';

export const TRAIN_SIZE = 512;

// RGBA in, RGB out, averaged over whole blocks. `from` must be a multiple of
// `to`; anything else is taken as it stands.
export function shrink(rgba, from, to) {
    const f = Math.max(1, Math.round(from / to));
    const out = new Uint8ClampedArray(to * to * 3);
    if (from !== f * to) return sample(rgba, from, to, out);
    for (let y = 0; y < to; y++) {
        for (let x = 0; x < to; x++) {
            const sum = [0, 0, 0];
            for (let dy = 0; dy < f; dy++) {
                for (let dx = 0; dx < f; dx++) {
                    const at = ((y * f + dy) * from + x * f + dx) * 4;
                    for (let c = 0; c < 3; c++) sum[c] += rgba[at + c];
                }
            }
            for (let c = 0; c < 3; c++) out[(y * to + x) * 3 + c] = sum[c] / (f * f);
        }
    }
    return out;
}

function sample(rgba, from, to, out) {
    for (let y = 0; y < to; y++) {
        for (let x = 0; x < to; x++) {
            const at = (Math.min(from - 1, Math.round(y * from / to)) * from
                + Math.min(from - 1, Math.round(x * from / to))) * 4;
            for (let c = 0; c < 3; c++) out[(y * to + x) * 3 + c] = rgba[at + c];
        }
    }
    return out;
}

// Every frame atom of a job, in one list of views. `only` keeps the poses a
// verify atom asks for and decodes nothing else.
export async function loadFrames(tars, { decode, size = TRAIN_SIZE, only = null } = {}) {
    const wanted = only ? new Set(only) : null;
    const views = [];
    let intr = null;
    for (const bytes of tars) {
        if (!bytes) continue;
        const files = readTar(bytes);
        const meta = files.get('transforms.json');
        if (!meta) throw new Error('a frame artifact has no transforms.json');
        const t = JSON.parse(new TextDecoder().decode(meta));
        intr = intr ?? t;
        for (const frame of t.frames) {
            if (wanted && !wanted.has(frame.pose_id)) continue;
            const raw = files.get(frame.file_path);
            if (!raw) throw new Error(`${frame.file_path} is not in its own tar`);
            const image = await decode(raw);
            views.push({
                id: frame.pose_id, kind: frame.kind,
                cam: cameraFrom(frame.transform_matrix, { ...t, size }),
                rgb: shrink(image.data, image.size, size),
            });
        }
    }
    views.sort((a, b) => a.id - b.id);
    return { intr, views, size };
}

// The poses no trainer is shown: four, spread across the set, kept back so the
// PSNR that decides a tile is measured on views it never fitted (WP3.1) and so
// `verify` has something independent to render (WP3.2).
export function holdout(count, n = 4) {
    return Array.from({ length: n }, (_, k) => Math.floor((k + 0.5) * count / n));
}
