#!/usr/bin/env node
// The surface materials the catalog stories register (TASKS-foundation.md
// FND.5). Square PNGs, power of two, written here for the same reason the
// models are: every CC0 texture host is outside this container's egress
// policy, and a fixture that cannot be re-made is not a fixture.
//
//   node tools/make-fixture-materials.mjs
//
// They are deterministic — the same bytes every run — so a SAN derived from
// one of them is a SAN a test can name. `too-big.png` is 3000 px wide on
// purpose: story 20 registers it and reads the refusal.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)),
    '../client/test/fixtures/assets');

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
}

// An 8-bit RGB PNG, one filter byte per row, deflated at a fixed level so the
// bytes are the same on every machine.
function png(size, pixel) {
    const raw = Buffer.alloc(size * (size * 3 + 1));
    let at = 0;
    for (let y = 0; y < size; y++) {
        raw[at++] = 0;
        for (let x = 0; x < size; x++) {
            const [r, g, b] = pixel(x, y);
            raw[at++] = r; raw[at++] = g; raw[at++] = b;
        }
    }
    const head = Buffer.alloc(13);
    head.writeUInt32BE(size, 0);
    head.writeUInt32BE(size, 4);
    head[8] = 8;      // bit depth
    head[9] = 2;      // colour type: truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', head),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// A cheap, repeatable hash of two coordinates: the same grain every run, and
// no two materials the same.
const grain = (x, y, seed) => {
    const n = Math.sin((x * 12.9898 + y * 78.233 + seed) * 43758.5453);
    return n - Math.floor(n);
};

const FILES = {
    // Asphalt: dark grey, a fine speckle, a little darker towards the edges.
    'asphalt.png': [256, (x, y) => {
        const g = 46 + Math.round(grain(x, y, 1) * 22);
        return [g, g, g + 2];
    }],
    // Kerb stone: pale grey with a coarser grain.
    'kerb-stone.png': [256, (x, y) => {
        const g = 172 + Math.round(grain(x >> 2, y >> 2, 7) * 26);
        return [g, g - 2, g - 6];
    }],
    // Too big, and not a power of two: what a refusal is for.
    'too-big.png': [3000, (x, y) => {
        const g = 120 + Math.round(grain(x >> 4, y >> 4, 3) * 40);
        return [g, g, g];
    }],
};

mkdirSync(OUT, { recursive: true });
for (const [name, [size, pixel]] of Object.entries(FILES)) {
    const bytes = png(size, pixel);
    writeFileSync(join(OUT, name), bytes);
    console.log(`${name}  ${size}x${size}  ${bytes.length} bytes`);
}
