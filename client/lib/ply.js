// ply.js — the gaussians, uncompressed. `assemble` writes one, `merge` reads
// sixteen and writes one, `sog` reads one and encodes it. The field order is
// the one the splat tooling uses, and tools/sogwrite.mjs writes the same file.

export const PLY_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// Spherical harmonics band 0: colour = 0.5 + SH_C0 * f_dc.
export const SH_C0 = 0.28209479177387814;

const FIELDS = ['x', 'y', 'z', 'r', 'g', 'b', 'a', 'sx', 'sy', 'sz',
    'qw', 'qx', 'qy', 'qz'];

export function emptySplats(n) {
    const f = { count: n };
    for (const k of FIELDS) f[k] = new Float32Array(n);
    return f;
}

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (v) => 1 / (1 + Math.exp(-v));

export function writePly(f) {
    const n = f.count;
    const head = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n'
        + `element vertex ${n}\n`
        + PLY_PROPS.map((p) => `property float ${p}\n`).join('')
        + 'end_header\n');
    const out = new Uint8Array(head.length + n * PLY_PROPS.length * 4);
    out.set(head);
    const view = new DataView(out.buffer, head.length);
    for (let i = 0; i < n; i++) {
        const v = [f.x[i], f.y[i], f.z[i],
            (f.r[i] - 0.5) / SH_C0, (f.g[i] - 0.5) / SH_C0, (f.b[i] - 0.5) / SH_C0,
            logit(Math.min(Math.max(f.a[i], 1e-6), 1 - 1e-6)),
            Math.log(f.sx[i]), Math.log(f.sy[i]), Math.log(f.sz[i]),
            f.qw[i], f.qx[i], f.qy[i], f.qz[i]];
        for (let k = 0; k < v.length; k++) {
            view.setFloat32((i * v.length + k) * 4, v[k], true);
        }
    }
    return out;
}

function header(bytes) {
    const text = new TextDecoder('ascii').decode(bytes.subarray(0, 4096));
    const end = text.indexOf('end_header\n');
    if (end < 0) throw new Error('not a ply: no end_header');
    const lines = text.slice(0, end).split('\n');
    const count = Number(lines.find((l) => l.startsWith('element vertex'))?.split(' ')[2]);
    const props = lines.filter((l) => l.startsWith('property float'))
        .map((l) => l.split(' ')[2]);
    if (!Number.isFinite(count)) throw new Error('not a ply: no vertex count');
    return { count, props, offset: end + 'end_header\n'.length };
}

export function readPly(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { count, props, offset } = header(buf);
    const view = new DataView(buf.buffer, buf.byteOffset + offset);
    const at = (i, name) => view.getFloat32((i * props.length + props.indexOf(name)) * 4, true);
    const f = emptySplats(count);
    for (let i = 0; i < count; i++) {
        f.x[i] = at(i, 'x'); f.y[i] = at(i, 'y'); f.z[i] = at(i, 'z');
        f.r[i] = 0.5 + SH_C0 * at(i, 'f_dc_0');
        f.g[i] = 0.5 + SH_C0 * at(i, 'f_dc_1');
        f.b[i] = 0.5 + SH_C0 * at(i, 'f_dc_2');
        f.a[i] = sigmoid(at(i, 'opacity'));
        f.sx[i] = Math.exp(at(i, 'scale_0'));
        f.sy[i] = Math.exp(at(i, 'scale_1'));
        f.sz[i] = Math.exp(at(i, 'scale_2'));
        f.qw[i] = at(i, 'rot_0'); f.qx[i] = at(i, 'rot_1');
        f.qy[i] = at(i, 'rot_2'); f.qz[i] = at(i, 'rot_3');
    }
    return f;
}
