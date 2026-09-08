// verify.js — `verify-v1`. Somebody else's tile, checked against its own frames.
//
// A trained tile cannot be reproduced bit for bit — two GPUs will not take the
// same optimisation path — so the .sog of a z16 or z18 tile is not accepted
// because it hashes right. It is accepted because three independent tabs
// download it, render two of the poses `frame-v1` rendered, and find the
// pictures close enough. Invariant 8: this is probabilistic quality assurance
// and nothing here is proof.
//
// The poses are the ones held back from training (client/lib/frames.js), so the
// trainer never fitted them, and each of the three verify atoms takes a
// different pair.

import { viewCount } from '../lib/cameras.js';
import { holdout, loadFrames, TRAIN_SIZE } from '../lib/frames.js';
import { decodeImage } from '../lib/geo.js';
import { sceneOf } from '../lib/gsmodel.js';
import { render, toRgba, toRgbaBytes } from '../lib/gsrast.js';
import { psnr } from '../lib/render.js';
import { decodeSog } from '../lib/sogenc.js';

export const ALGO = 'verify-v1';
export const POSES = 2;
export const MIN_PSNR = 22;

// Two of the four held-out poses, rotated by which of the three verifies this
// is, so between them the three cover the whole set.
export function posesFor(params) {
    const n = viewCount(params?.camera_set) || 0;
    if (!n) throw new Error(`verify does not know camera set ${params?.camera_set}`);
    const all = holdout(n);
    const from = ((Number(params?.index) || 1) - 1) % all.length;
    return Array.from({ length: POSES }, (_, k) => all[(from + k) % all.length]);
}

export async function run({ atom, inputs, canvas, log }) {
    if (!inputs?.sog) throw new Error('verify needs the .sog it is checking');
    const tars = [].concat(inputs.frames ?? []).filter(Boolean);
    if (!tars.length) throw new Error('verify needs the frames to compare against');
    const poses = posesFor(atom.params);
    const size = Number(atom.params?.size) || TRAIN_SIZE;
    const min = Number(atom.params?.min_psnr) || MIN_PSNR;

    const { splats } = await decodeSog(inputs.sog, (b) => decodeImage(b, canvas));
    const { views } = await loadFrames(tars, { decode: (b) => decodeImage(b, canvas),
        size, only: poses });
    if (views.length < poses.length) {
        throw new Error(`only ${views.length} of poses ${poses} are in these frames`);
    }
    const scene = sceneOf(splats);
    const scores = views.map((v) => ({ pose: v.id,
        psnr: psnr(toRgba(render(v.cam, scene)), toRgbaBytes(v.rgb)) }));
    // Capped, not infinite: JSON has no infinity and submit_atom's structural
    // rule wants a number (db/0017_verifydag.sql).
    const worst = Math.min(99, ...scores.map((s) => s.psnr));
    const passed = worst >= min;
    log?.({ event: 'verified', splats: splats.count, poses, worst, passed });

    // No artifact: the answer is the result. submit_atom records it against the
    // .sog this atom depends on (db/0017_verify.sql).
    return {
        files: [],
        output: null,
        result: { passed, psnr: worst, min_psnr: min, splat_count: splats.count,
            poses, views: scores.map((s) => ({ ...s, psnr: Math.min(99, s.psnr) })),
            finite: true, algo_version: ALGO },
    };
}
