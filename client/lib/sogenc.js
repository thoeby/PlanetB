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
// WP2.5 needs the way in: `merge` reads sixteen children. WP2.6 adds the way
// out.

import { emptySplats } from './ply.js';

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.SQRT2;
const PLANES = ['means_l', 'means_u', 'quats', 'scales', 'sh0'];

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
