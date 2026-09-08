// sogenc.js — the SOG v1 bundle, in the browser.
//
// A .sog is a zip holding meta.json and one lossless WebP per attribute. The
// quantisation is the inverse of the engine's dequantisation, which is the
// actual specification (tools/sogwrite.mjs writes the same file on the dev box
// and client/test/e2e/stream.spec.js proves PlayCanvas reads it):
//
//   centre  n = (means_u<<8 | means_l) / 65535, v = mix(mins, maxs, n),
//           p = sign(v) * (exp(|v|) - 1)
//   scale   exp(mix(scales_mins, scales_maxs, b/255))
//   colour  0.5 + mix(sh0_mins, sh0_maxs, b/255) * SH_C0, alpha = sigmoid(...)
//   rot     a,b,c = (b/255 - 0.5) * sqrt(2); the omitted component is
//           d = sqrt(1 - a^2 - b^2 - c^2) and byte 3 - 252 says which slot it
//           fills, counted over (w, x, y, z).
//
// One thing the browser forces on the format: a canvas stores colour
// premultiplied by alpha, so RGB under a low alpha does not survive being
// encoded. Every plane here therefore keeps its alpha byte high — 255 where the
// format leaves it free, and sh0's opacity is remapped into the top half of the
// range, which costs one bit of opacity and keeps the colour exact to a count.
// ALPHA_FLOOR is that floor; the widened mins/maxs it implies are what the
// engine reads back, so the bundle is still an ordinary SOG v1.

import { emptySplats } from './ply.js';

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.SQRT2;
const PLANES = ['means_l', 'means_u', 'quats', 'scales', 'sh0'];
const ALPHA_FLOOR = 128;

// ---------------------------------------------------------------------- zip

export function unzip(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const eocd = buf.length - 22;
    if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error('not a zip');
    const n = view.getUint16(eocd + 8, true);
    let off = view.getUint32(eocd + 16, true);
    const files = new Map();
    for (let i = 0; i < n; i++) {
        const nameLen = view.getUint16(off + 28, true);
        const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
        const method = view.getUint16(off + 10, true);
        if (method !== 0) throw new Error(`${name} is deflated; sog stores its entries`);
        const size = view.getUint32(off + 20, true);
        const lfh = view.getUint32(off + 42, true);
        const start = lfh + 30 + view.getUint16(lfh + 26, true) + view.getUint16(lfh + 28, true);
        files.set(name, buf.subarray(start, start + size));
        off += 46 + nameLen + view.getUint16(off + 30, true) + view.getUint16(off + 32, true);
    }
    return files;
}

// -------------------------------------------------------------------- decode

const mix = (a, b, t) => a * (1 - t) + b * t;

function decodeQuat(q0, q1, q2, mode, out, i) {
    const rest = [(q0 / 255 - 0.5) * SQRT2, (q1 / 255 - 0.5) * SQRT2,
        (q2 / 255 - 0.5) * SQRT2];
    const d = Math.sqrt(Math.max(0, 1 - rest[0] ** 2 - rest[1] ** 2 - rest[2] ** 2));
    const wxyz = [0, 0, 0, 0];
    wxyz[mode] = d;
    let k = 0;
    for (let s = 0; s < 4; s++) if (s !== mode) wxyz[s] = rest[k++];
    [out.qw[i], out.qx[i], out.qy[i], out.qz[i]] = wxyz;
}

// planes: { name: Uint8ClampedArray } of RGBA texels, as the WebPs decode.
export function splatsFrom(meta, planes) {
    const n = meta.count;
    const f = emptySplats(n);
    const axes = ['x', 'y', 'z'];
    const rgb = ['r', 'g', 'b'];
    const size = ['sx', 'sy', 'sz'];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const u = ((planes.means_u[i * 4 + k] << 8) + planes.means_l[i * 4 + k]) / 65535;
            const v = mix(meta.means.mins[k], meta.means.maxs[k], u);
            f[axes[k]][i] = Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
            f[size[k]][i] = Math.exp(mix(meta.scales.mins[k], meta.scales.maxs[k],
                planes.scales[i * 4 + k] / 255));
            f[rgb[k]][i] = 0.5 + SH_C0 * mix(meta.sh0.mins[k], meta.sh0.maxs[k],
                planes.sh0[i * 4 + k] / 255);
        }
        const logit = mix(meta.sh0.mins[3], meta.sh0.maxs[3], planes.sh0[i * 4 + 3] / 255);
        f.a[i] = 1 / (1 + Math.exp(-logit));
        decodeQuat(planes.quats[i * 4], planes.quats[i * 4 + 1], planes.quats[i * 4 + 2],
            planes.quats[i * 4 + 3] - 252, f, i);
    }
    return f;
}

// decodeImage: (bytes) => { data, size } — client/lib/geo.js has the browser's.
export async function decodeSog(bytes, decodeImage) {
    const files = unzip(bytes);
    const meta = JSON.parse(new TextDecoder().decode(files.get('meta.json')));
    if (meta.version !== 1) throw new Error(`sog version ${meta.version} is not v1`);
    const planes = {};
    for (const name of PLANES) {
        planes[name] = (await decodeImage(files.get(`${name}.webp`))).data;
    }
    return { meta, splats: splatsFrom(meta, planes) };
}

// ------------------------------------------------------------ exact planes
//
// A 2D canvas premultiplies; WebGL, told not to, does not. Reading a plane back
// through a texture is the only way to see the bytes that are really in the
// file, which is what `merge` needs and what the round-trip test checks.

function glOf(canvas, w, h) {
    const gl = canvas(w, h).getContext('webgl2', {
        premultipliedAlpha: false, alpha: true, antialias: false, depth: false,
    });
    if (!gl) throw new Error('no webgl2 context to read a sog plane with');
    return gl;
}

export async function exactPixels(bytes, canvas) {
    const bitmap = await createImageBitmap(new Blob([bytes]),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const size = bitmap.width;
    const gl = glOf(canvas, size, bitmap.height);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const data = new Uint8Array(size * bitmap.height * 4);
    gl.readPixels(0, 0, size, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    bitmap.close();
    return { data, size, height: data.length / 4 / size };
}

// The browser's own WebP encoder, lossless at quality 1. A plane is data, not a
// picture, so nothing here may resample or filter it.
async function toWebp(rgba, w, h, canvas) {
    const c = canvas(w, h);
    c.getContext('2d', { willReadFrequently: true })
        .putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset,
            rgba.byteLength), w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 1 });
    return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------- zip

const CRC = (() => {
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
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Stored entries, no timestamps: the same splats give the same bytes and so the
// same sha256 (Invariant 1).
export function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nb = enc.encode(name);
        const crc = crc32(data);
        const lfh = new DataView(new ArrayBuffer(30));
        lfh.setUint32(0, 0x04034b50, true);
        lfh.setUint16(4, 20, true);
        lfh.setUint32(14, crc, true);
        lfh.setUint32(18, data.length, true);
        lfh.setUint32(22, data.length, true);
        lfh.setUint16(26, nb.length, true);
        parts.push(new Uint8Array(lfh.buffer), nb, data);

        const cdr = new DataView(new ArrayBuffer(46));
        cdr.setUint32(0, 0x02014b50, true);
        cdr.setUint16(4, 20, true);
        cdr.setUint16(6, 20, true);
        cdr.setUint32(16, crc, true);
        cdr.setUint32(20, data.length, true);
        cdr.setUint32(24, data.length, true);
        cdr.setUint16(28, nb.length, true);
        cdr.setUint32(42, offset, true);
        central.push(new Uint8Array(cdr.buffer), nb);
        offset += 30 + nb.length + data.length;
    }
    const cdLength = central.reduce((s, p) => s + p.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdLength, true);
    eocd.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
}

// -------------------------------------------------------------------- encode

const logEncode = (v) => Math.sign(v) * Math.log(1 + Math.abs(v));
const q8 = (v, lo, hi) => Math.max(0, Math.min(255, Math.round((v - lo) / (hi - lo) * 255)));
const q16 = (v, lo, hi) =>
    Math.max(0, Math.min(65535, Math.round((v - lo) / (hi - lo) * 65535)));

// A degenerate range would divide by zero on the way in and give NaN on the way
// out; widen it instead and let every sample land mid-range.
function spread(mins, maxs) {
    for (let i = 0; i < mins.length; i++) {
        if (maxs[i] - mins[i] < 1e-9) { mins[i] -= 5e-10; maxs[i] += 5e-10; }
    }
}

// Width is a power of two so the texture suits every backend; the engine
// derives a splat's texel from the texture's own dimensions.
export function planeDims(count) {
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
    return [q8(rest[0] / SQRT2 + 0.5, 0, 1), q8(rest[1] / SQRT2 + 0.5, 0, 1),
        q8(rest[2] / SQRT2 + 0.5, 0, 1), 252 + mode];
}

function analyse(f) {
    const n = f.count;
    const r = {
        pos: new Float64Array(n * 3), scl: new Float64Array(n * 3),
        col: new Float64Array(n * 4),
        meanMins: [Infinity, Infinity, Infinity], meanMaxs: [-Infinity, -Infinity, -Infinity],
        scaleMins: [Infinity, Infinity, Infinity], scaleMaxs: [-Infinity, -Infinity, -Infinity],
        colMins: [Infinity, Infinity, Infinity, Infinity],
        colMaxs: [-Infinity, -Infinity, -Infinity, -Infinity],
    };
    const axes = ['x', 'y', 'z'];
    const sizes = ['sx', 'sy', 'sz'];
    const rgb = ['r', 'g', 'b'];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const p = logEncode(f[axes[k]][i]);
            r.pos[i * 3 + k] = p;
            r.meanMins[k] = Math.min(r.meanMins[k], p);
            r.meanMaxs[k] = Math.max(r.meanMaxs[k], p);
            const s = Math.log(Math.max(1e-8, f[sizes[k]][i]));
            r.scl[i * 3 + k] = s;
            r.scaleMins[k] = Math.min(r.scaleMins[k], s);
            r.scaleMaxs[k] = Math.max(r.scaleMaxs[k], s);
            const c = (f[rgb[k]][i] - 0.5) / SH_C0;
            r.col[i * 4 + k] = c;
            r.colMins[k] = Math.min(r.colMins[k], c);
            r.colMaxs[k] = Math.max(r.colMaxs[k], c);
        }
        const alpha = Math.min(1 - 1e-6, Math.max(1e-6, f.a[i]));
        const logit = Math.log(alpha / (1 - alpha));
        r.col[i * 4 + 3] = logit;
        r.colMins[3] = Math.min(r.colMins[3], logit);
        r.colMaxs[3] = Math.max(r.colMaxs[3], logit);
    }
    spread(r.meanMins, r.meanMaxs);
    spread(r.scaleMins, r.scaleMaxs);
    spread(r.colMins, r.colMaxs);
    // sh0's fourth channel is the texture's alpha, so its bytes are kept above
    // ALPHA_FLOOR by widening the range the engine reads them back through.
    const t = ALPHA_FLOOR / 255;
    r.colMins[3] = (r.colMins[3] - r.colMaxs[3] * t) / (1 - t);
    return r;
}

function fillPlanes(f, a, planes) {
    for (let i = 0; i < f.count; i++) {
        for (let k = 0; k < 3; k++) {
            const q = q16(a.pos[i * 3 + k], a.meanMins[k], a.meanMaxs[k]);
            planes.means_l[i * 4 + k] = q & 0xff;
            planes.means_u[i * 4 + k] = q >> 8;
            planes.scales[i * 4 + k] = q8(a.scl[i * 3 + k], a.scaleMins[k], a.scaleMaxs[k]);
            planes.sh0[i * 4 + k] = q8(a.col[i * 4 + k], a.colMins[k], a.colMaxs[k]);
        }
        planes.means_l[i * 4 + 3] = 255;
        planes.means_u[i * 4 + 3] = 255;
        planes.scales[i * 4 + 3] = 255;
        planes.sh0[i * 4 + 3] = Math.max(ALPHA_FLOOR,
            q8(a.col[i * 4 + 3], a.colMins[3], a.colMaxs[3]));
        const packed = encodeQuat(f.qx[i], f.qy[i], f.qz[i], f.qw[i]);
        for (let k = 0; k < 4; k++) planes.quats[i * 4 + k] = packed[k];
    }
}

export function sogMeta(f, a) {
    return {
        version: 1,
        count: f.count,
        antialias: false,
        means: {
            shape: [f.count, 3], dtype: 'uint16', encoding: 'quantized',
            mins: a.meanMins, maxs: a.meanMaxs, files: ['means_l.webp', 'means_u.webp'],
        },
        scales: {
            shape: [f.count, 3], dtype: 'uint8', encoding: 'quantized',
            mins: a.scaleMins, maxs: a.scaleMaxs, files: ['scales.webp'],
        },
        quats: {
            shape: [f.count, 4], dtype: 'uint8', encoding: 'quaternion_packed',
            files: ['quats.webp'],
        },
        sh0: {
            shape: [f.count, 1, 4], dtype: 'uint8', encoding: 'quantized',
            mins: a.colMins, maxs: a.colMaxs, files: ['sh0.webp'],
        },
    };
}

// splats: what lib/ply.js reads — positions in metres in the tile's own frame,
// scales the gaussian's sigma in metres, colour and alpha 0..1. Everything the
// format decides happens here, with no image codec in sight, so it can be
// checked without a browser.
export function quantise(f) {
    const { width, height } = planeDims(f.count);
    const planes = Object.fromEntries(
        PLANES.map((name) => [name, new Uint8Array(width * height * 4)]));
    const a = analyse(f);
    fillPlanes(f, a, planes);
    return { meta: sogMeta(f, a), planes, width, height };
}

export async function encodeSog(f, canvas) {
    const { meta, planes, width, height } = quantise(f);
    const files = [{ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)) }];
    for (const name of PLANES) {
        const data = await toWebp(planes[name], width, height, canvas);
        files.push({ name: `${name}.webp`, data });
    }
    return { bytes: zipStore(files), meta, width, height };
}
