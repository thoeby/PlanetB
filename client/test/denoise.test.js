// The denoiser smooths along a surface and stops at an edge in the normals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { denoise, normalsFrom } from '../lib/denoise.js';

const n = 16;

test('noise on one flat face is smoothed away', () => {
    const rgb = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < n * n; i++) {
        normals[i * 3 + 1] = 1;
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = 0.5 + (rand() - 0.5) * 0.1;
    }
    const out = denoise(rgb, normals, n);
    let before = 0; let after = 0;
    for (let i = 0; i < n * n * 3; i++) {
        before += (rgb[i] - 0.5) ** 2;
        after += (out[i] - 0.5) ** 2;
    }
    assert.ok(after < before / 4, `variance ${before} -> ${after}`);
});

test('two faces with different normals do not bleed into each other', () => {
    const rgb = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            const left = x < n / 2;
            normals[i * 3 + (left ? 1 : 0)] = 1;
            rgb[i * 3] = left ? 1 : 0; rgb[i * 3 + 1] = left ? 1 : 0; rgb[i * 3 + 2] = left ? 1 : 0;
        }
    }
    const out = denoise(rgb, normals, n);
    const at = (x) => out[(8 * n + x) * 3];
    assert.ok(at(7) > 0.99 && at(8) < 0.01, `edge: ${at(7)} | ${at(8)}`);
});

test('the sky has no normal and is left alone', () => {
    const bytes = new Uint8Array(n * n * 4);
    bytes.set([255, 128, 128, 255], 0);      // +x, drawn
    const nm = normalsFrom(bytes, n);
    assert.ok(Math.abs(nm[0] - 1) < 0.02 && nm[3] === 0);
});
