// sogwrite.mjs — writes PlayCanvas SOG v1 bundles.
//
// A .sog is a zip holding meta.json plus one lossless WebP per attribute; the
// engine's SogBundleParser reads exactly those names out of meta.<key>.files.
// The quantisation below is the inverse of the engine's dequantisation, which
// is the actual specification:
//
//   centre  n = (means_u<<8 | means_l) / 65535, v = mix(mins, maxs, n),
//           p = sign(v) * (exp(|v|) - 1)
//   scale   exp(mix(scales_mins, scales_maxs, b/255))
//   colour  0.5 + mix(sh0_mins, sh0_maxs, b/255) * SH_C0, alpha = sigmoid(...)
//   rot     a,b,c = (b/255 - 0.5) * sqrt(2); the omitted component is
//           d = sqrt(1 - a² - b² - c²) and byte 3 - 252 says which slot it fills,
//           counted over (w, x, y, z).
//
// WebP encoding is shelled out to cwebp (libwebp): node has no encoder, and the
// client-side one is lib/sogenc.js in WP2.6. This runs on the dev box only.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.SQRT2;

// ------------------------------------------------------------------ zip (store)

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Stored entries only: the payloads are WebP and json, and the parser accepts
// compression method 0. No timestamps go in, so the same splats give the same
// bytes and therefore the same sha256 (Invariant 1).
export function zipStore(files) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(data.length, 18);
        lfh.writeUInt32LE(data.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        locals.push(lfh, nameBuf, data);

        const cdr = Buffer.alloc(46);
        cdr.writeUInt32LE(0x02014b50, 0);
        cdr.writeUInt16LE(20, 4);
        cdr.writeUInt16LE(20, 6);
        cdr.writeUInt32LE(crc, 16);
        cdr.writeUInt32LE(data.length, 20);
        cdr.writeUInt32LE(data.length, 24);
        cdr.writeUInt16LE(nameBuf.length, 28);
        cdr.writeUInt32LE(offset, 42);
        central.push(cdr, nameBuf);

        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

// ----------------------------------------------------------------------- webp

export function webpLossless(rgba, width, height) {
    const dir = mkdtempSync(join(tmpdir(), 'sogwrite-'));
    try {
        const pam = join(dir, 'a.pam');
        const out = join(dir, 'a.webp');
        const header = `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\n`
            + 'MAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n';
        writeFileSync(pam, Buffer.concat([Buffer.from(header, 'ascii'), rgba]));
        // -exact keeps RGB under transparent alpha; without it cwebp is free to
        // rewrite those bytes and the quats/sh0 payloads are not colours.
        execFileSync('cwebp', ['-lossless', '-exact', '-quiet', pam, '-o', out]);
        return readFileSync(out);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------- quantisation

const logEncode = (v) => Math.sign(v) * Math.log(1 + Math.abs(v));

function spread(mins, maxs) {
    // A degenerate range would divide by zero on the way in and produce NaN on
    // the way out; widen it instead and let every sample land mid-range.
    for (let i = 0; i < mins.length; i++) {
        if (maxs[i] - mins[i] < 1e-9) { mins[i] -= 5e-10; maxs[i] += 5e-10; }
    }
}

const q8 = (v, lo, hi) => Math.max(0, Math.min(255, Math.round((v - lo) / (hi - lo) * 255)));
const q16 = (v, lo, hi) => Math.max(0, Math.min(65535, Math.round((v - lo) / (hi - lo) * 65535)));

// width is a power of two so the texture is friendly to every backend; the
// engine derives the splat's texel from the texture's own dimensions.
function dims(count) {
    const width = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(count)))));
    return { width, height: Math.ceil(count / width) };
}

function encodeQuat(qx, qy, qz, qw) {
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    let q = [qw / n, qx / n, qy / n, qz / n];      // (w, x, y, z), the engine's order
    let mode = 0;
    for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[mode])) mode = i;
    // The omitted component comes back as a square root, so it must be positive.
    if (q[mode] < 0) q = q.map((v) => -v);
    const rest = q.filter((_, i) => i !== mode);
    return [
        q8(rest[0] / SQRT2 + 0.5, 0, 1),
        q8(rest[1] / SQRT2 + 0.5, 0, 1),
        q8(rest[2] / SQRT2 + 0.5, 0, 1),
        252 + mode,
    ];
}

// ------------------------------------------------------------------ packSog

// splats: { count, x, y, z, r, g, b, a, sx, sy, sz, qx, qy, qz, qw } of typed
// arrays. Positions are metres in the tile's local frame, scales are the
// gaussian's sigma in metres, colour and alpha are 0..1.
// Walks the splats once, converting each attribute into the space the format
// stores it in and collecting the per-channel range that quantisation needs.
function analyse(splats, n) {
    const pos = new Float64Array(n * 3);
    const scl = new Float64Array(n * 3);
    const col = new Float64Array(n * 4);
    const r = {
        meanMins: [Infinity, Infinity, Infinity], meanMaxs: [-Infinity, -Infinity, -Infinity],
        scaleMins: [Infinity, Infinity, Infinity], scaleMaxs: [-Infinity, -Infinity, -Infinity],
        colMins: [Infinity, Infinity, Infinity, Infinity],
        colMaxs: [-Infinity, -Infinity, -Infinity, -Infinity],
        pos, scl, col,
    };
    const axes = ['x', 'y', 'z'], sizes = ['sx', 'sy', 'sz'], rgb = ['r', 'g', 'b'];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const p = logEncode(splats[axes[k]][i]);
            pos[i * 3 + k] = p;
            r.meanMins[k] = Math.min(r.meanMins[k], p);
            r.meanMaxs[k] = Math.max(r.meanMaxs[k], p);
            const s = Math.log(Math.max(1e-8, splats[sizes[k]][i]));
            scl[i * 3 + k] = s;
            r.scaleMins[k] = Math.min(r.scaleMins[k], s);
            r.scaleMaxs[k] = Math.max(r.scaleMaxs[k], s);
            const c = (splats[rgb[k]][i] - 0.5) / SH_C0;
            col[i * 4 + k] = c;
            r.colMins[k] = Math.min(r.colMins[k], c);
            r.colMaxs[k] = Math.max(r.colMaxs[k], c);
        }
        const alpha = Math.min(1 - 1e-6, Math.max(1e-6, splats.a[i]));
        const logit = Math.log(alpha / (1 - alpha));
        col[i * 4 + 3] = logit;
        r.colMins[3] = Math.min(r.colMins[3], logit);
        r.colMaxs[3] = Math.max(r.colMaxs[3], logit);
    }
    spread(r.meanMins, r.meanMaxs);
    spread(r.scaleMins, r.scaleMaxs);
    spread(r.colMins, r.colMaxs);
    return r;
}

function fillPlanes(splats, n, a, planes) {
    const { meansL, meansU, quats, scales, sh0 } = planes;
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const q = q16(a.pos[i * 3 + k], a.meanMins[k], a.meanMaxs[k]);
            meansL[i * 4 + k] = q & 0xff;
            meansU[i * 4 + k] = q >> 8;
            scales[i * 4 + k] = q8(a.scl[i * 3 + k], a.scaleMins[k], a.scaleMaxs[k]);
            sh0[i * 4 + k] = q8(a.col[i * 4 + k], a.colMins[k], a.colMaxs[k]);
        }
        meansL[i * 4 + 3] = 255;
        meansU[i * 4 + 3] = 255;
        scales[i * 4 + 3] = 255;
        sh0[i * 4 + 3] = q8(a.col[i * 4 + 3], a.colMins[3], a.colMaxs[3]);
        const packed = encodeQuat(splats.qx[i], splats.qy[i], splats.qz[i], splats.qw[i]);
        for (let k = 0; k < 4; k++) quats[i * 4 + k] = packed[k];
    }
}

// splats: { count, x, y, z, r, g, b, a, sx, sy, sz, qx, qy, qz, qw } of typed
// arrays. Positions are metres in the tile's local frame, scales are the
// gaussian's sigma in metres, colour and alpha are 0..1.
export function packSog(splats) {
    const n = splats.count;
    const { width, height } = dims(n);
    const plane = () => Buffer.alloc(width * height * 4);
    const planes = {
        meansL: plane(), meansU: plane(), quats: plane(), scales: plane(), sh0: plane(),
    };
    const a = analyse(splats, n);
    fillPlanes(splats, n, a, planes);

    const meta = {
        version: 1,
        count: n,
        antialias: false,
        means: {
            shape: [n, 3], dtype: 'uint16', encoding: 'quantized',
            mins: a.meanMins, maxs: a.meanMaxs, files: ['means_l.webp', 'means_u.webp'],
        },
        scales: {
            shape: [n, 3], dtype: 'uint8', encoding: 'quantized',
            mins: a.scaleMins, maxs: a.scaleMaxs, files: ['scales.webp'],
        },
        quats: {
            shape: [n, 4], dtype: 'uint8', encoding: 'quaternion_packed',
            files: ['quats.webp'],
        },
        sh0: {
            shape: [n, 1, 4], dtype: 'uint8', encoding: 'quantized',
            mins: a.colMins, maxs: a.colMaxs, files: ['sh0.webp'],
        },
    };

    const bytes = zipStore([
        { name: 'meta.json', data: Buffer.from(JSON.stringify(meta), 'utf8') },
        { name: 'means_l.webp', data: webpLossless(planes.meansL, width, height) },
        { name: 'means_u.webp', data: webpLossless(planes.meansU, width, height) },
        { name: 'quats.webp', data: webpLossless(planes.quats, width, height) },
        { name: 'scales.webp', data: webpLossless(planes.scales, width, height) },
        { name: 'sh0.webp', data: webpLossless(planes.sh0, width, height) },
    ]);
    return { bytes, meta, width, height };
}

// ----------------------------------------------------------------- unpackSog
//
// The inverse, used to check a bundle before it is published. It is a
// transcription of the engine's GSplatSogIterator, so a bundle that survives
// this round-trip is one PlayCanvas will read the same way.

function unzip(buf) {
    const eocd = buf.length - 22;
    if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('not a zip');
    const n = buf.readUInt16LE(eocd + 8);
    let off = buf.readUInt32LE(eocd + 16);
    const files = {};
    for (let i = 0; i < n; i++) {
        const nameLen = buf.readUInt16LE(off + 28);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        const method = buf.readUInt16LE(off + 10);
        const size = buf.readUInt32LE(off + 20);
        const lfh = buf.readUInt32LE(off + 42);
        const start = lfh + 30 + buf.readUInt16LE(lfh + 26) + buf.readUInt16LE(lfh + 28);
        const raw = buf.subarray(start, start + size);
        files[name] = method === 0 ? raw : inflateRawSync(raw);
        off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    }
    return files;
}

function readWebp(data) {
    const dir = mkdtempSync(join(tmpdir(), 'sogread-'));
    try {
        const src = join(dir, 'a.webp'), out = join(dir, 'a.pam');
        writeFileSync(src, data);
        execFileSync('dwebp', ['-quiet', src, '-pam', '-o', out]);
        const pam = readFileSync(out);
        const head = pam.indexOf('ENDHDR\n') + 7;
        const text = pam.toString('ascii', 0, head);
        return {
            width: Number(/WIDTH (\d+)/.exec(text)[1]),
            height: Number(/HEIGHT (\d+)/.exec(text)[1]),
            rgba: pam.subarray(head),
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export function unpackSog(bytes) {
    const files = unzip(bytes);
    const meta = JSON.parse(files['meta.json'].toString('utf8'));
    const tex = {};
    for (const name of ['means_l', 'means_u', 'quats', 'scales', 'sh0']) {
        tex[name] = readWebp(files[`${name}.webp`]).rgba;
    }
    const mix = (a, b, t) => a * (1 - t) + b * t;
    const out = { count: meta.count, x: [], y: [], z: [], r: [], g: [], b: [], a: [] };
    const axes = ['x', 'y', 'z'], rgb = ['r', 'g', 'b'];
    for (let i = 0; i < meta.count; i++) {
        for (let k = 0; k < 3; k++) {
            const n = ((tex.means_u[i * 4 + k] << 8) + tex.means_l[i * 4 + k]) / 65535;
            const v = mix(meta.means.mins[k], meta.means.maxs[k], n);
            out[axes[k]].push(Math.sign(v) * (Math.exp(Math.abs(v)) - 1));
            const c = mix(meta.sh0.mins[k], meta.sh0.maxs[k], tex.sh0[i * 4 + k] / 255);
            out[rgb[k]].push(0.5 + c * SH_C0);
        }
        const logit = mix(meta.sh0.mins[3], meta.sh0.maxs[3], tex.sh0[i * 4 + 3] / 255);
        out.a.push(1 / (1 + Math.exp(-logit)));
    }
    return { meta, splats: out };
}
