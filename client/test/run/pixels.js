// Looking at the 3D view, which has no DOM to assert on.
//
// A story says "the model is there" or "the ground followed"; what proves it is
// that the picture at that spot changed, or stopped being empty. Playwright's
// own snapshots want a committed baseline per platform, and a splat render is
// not the same twice on two machines — so nothing is compared against a stored
// picture here. Only this run's pictures are compared with each other.

import { inflateSync } from 'node:zlib';

// A PNG as Playwright writes it: 8-bit, non-interlaced, one IDAT stream.
export function decodePng(buf) {
    let at = 8;
    let head = null;
    const parts = [];
    while (at + 8 <= buf.length) {
        const len = buf.readUInt32BE(at);
        const kind = buf.toString('ascii', at + 4, at + 8);
        const data = buf.subarray(at + 8, at + 8 + len);
        if (kind === 'IHDR') {
            head = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
                depth: data[8], colour: data[9], interlace: data[12] };
        } else if (kind === 'IDAT') parts.push(data);
        else if (kind === 'IEND') break;
        at += len + 12;
    }
    if (!head || head.depth !== 8 || head.interlace !== 0) {
        throw new Error('not an 8-bit non-interlaced PNG');
    }
    const stride = { 0: 1, 2: 3, 4: 2, 6: 4 }[head.colour];
    if (!stride) throw new Error(`unsupported PNG colour type ${head.colour}`);
    return { ...head, stride, data: unfilter(inflateSync(Buffer.concat(parts)), head, stride) };
}

function unfilter(raw, head, stride) {
    const line = head.width * stride;
    const out = Buffer.alloc(head.height * line);
    for (let y = 0; y < head.height; y++) {
        const kind = raw[y * (line + 1)];
        const src = raw.subarray(y * (line + 1) + 1, y * (line + 1) + 1 + line);
        for (let i = 0; i < line; i++) {
            const a = i >= stride ? out[y * line + i - stride] : 0;
            const b = y > 0 ? out[(y - 1) * line + i] : 0;
            const c = i >= stride && y > 0 ? out[(y - 1) * line + i - stride] : 0;
            let value = src[i];
            if (kind === 1) value += a;
            else if (kind === 2) value += b;
            else if (kind === 3) value += (a + b) >> 1;
            else if (kind === 4) value += paeth(a, b, c);
            out[y * line + i] = value & 0xff;
        }
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

// The share of pixels that differ by more than `tolerance` (0..255 per channel).
export function differs(before, after, tolerance = 12) {
    const a = decodePng(before);
    const b = decodePng(after);
    if (a.width !== b.width || a.height !== b.height) return 1;
    let changed = 0;
    const pixels = a.width * a.height;
    for (let i = 0; i < pixels; i++) {
        for (let c = 0; c < 3; c++) {
            if (Math.abs(a.data[i * a.stride + c] - b.data[i * b.stride + c]) > tolerance) {
                changed += 1;
                break;
            }
        }
    }
    return changed / pixels;
}

// How much of the picture is not one flat colour — an empty sky, a black
// canvas and a page that never drew are all "nothing there".
export function variety(png) {
    const img = decodePng(png);
    const seen = new Set();
    const pixels = img.width * img.height;
    for (let i = 0; i < pixels; i++) {
        seen.add((img.data[i * img.stride] >> 4) * 256
            + (img.data[i * img.stride + 1] >> 4) * 16
            + (img.data[i * img.stride + 2] >> 4));
    }
    return seen.size;
}
