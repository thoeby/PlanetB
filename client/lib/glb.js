// glb.js — the GLB container and the glTF accessors inside it. Reading only
// what canon-v1 needs, and writing back a container with nothing in it that the
// spec does not require.
//
// A GLB is a 12-byte header and a run of chunks: JSON first, then at most one
// BIN. Chunks are 4-byte aligned; JSON pads with spaces, BIN with zeroes.

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export const COMPONENT = {
    5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
    5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

export const COMPONENT_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// ------------------------------------------------------------------ container

export function parseGlb(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) {
        throw new Error('not a GLB: bad magic');
    }
    if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is supported');
    let json = null;
    let bin = null;
    let at = 12;
    while (at + 8 <= u8.byteLength) {
        const len = dv.getUint32(at, true);
        const type = dv.getUint32(at + 4, true);
        const body = u8.subarray(at + 8, at + 8 + len);
        if (type === JSON_CHUNK && json === null) {
            json = JSON.parse(new TextDecoder().decode(body));
        } else if (type === BIN_CHUNK && bin === null) {
            bin = body;
        }
        at += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return { json, bin };
}

const padTo4 = (n) => (4 - (n % 4)) % 4;

export function buildGlb(json, bin) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = padTo4(jsonBytes.length);
    const binPad = bin ? padTo4(bin.length) : 0;
    const binChunk = bin ? 8 + bin.length + binPad : 0;
    const total = 12 + 8 + jsonBytes.length + jsonPad + binChunk;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length + jsonPad, true);
    dv.setUint32(16, JSON_CHUNK, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
    if (bin) {
        const at = 20 + jsonBytes.length + jsonPad;
        dv.setUint32(at, bin.length + binPad, true);
        dv.setUint32(at + 4, BIN_CHUNK, true);
        out.set(bin, at + 8);
    }
    return out;
}

// --------------------------------------------------------------- stable JSON

// Objects come back with their keys in code-unit order; arrays keep theirs,
// because an array index is meaning in glTF. This is half of what makes a
// canonical GLB reproducible (Invariant 7 in spirit: same input, same bytes).
export function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
}

// ------------------------------------------------------------------- buffers

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(text) {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array((clean.length * 3) >> 2);
    let bits = 0;
    let n = 0;
    let at = 0;
    for (const ch of clean) {
        bits = (bits << 6) | B64.indexOf(ch);
        n += 6;
        if (n >= 8) {
            n -= 8;
            out[at++] = (bits >> n) & 255;
        }
    }
    return out.subarray(0, at);
}

// The GLB's own BIN chunk, or a data: URI. An external file has no meaning for
// an upload — there is nothing to fetch it from — so it is refused.
export function resolveBuffers(gltf, bin) {
    return (gltf.buffers ?? []).map((buf, i) => {
        if (buf.uri === undefined) {
            if (i !== 0 || !bin) throw new Error(`buffer ${i} has no uri and no BIN chunk`);
            return bin;
        }
        const m = /^data:[^,]*;base64,(.*)$/s.exec(buf.uri);
        if (!m) throw new Error('external buffers are not supported: ' + buf.uri.slice(0, 32));
        return base64(m[1]);
    });
}

export function viewBytes(gltf, buffers, index) {
    const view = gltf.bufferViews[index];
    const buf = buffers[view.buffer];
    const at = view.byteOffset ?? 0;
    return buf.subarray(at, at + view.byteLength);
}

// ----------------------------------------------------------------- accessors

// Returns a Float64Array of `count * components` values, de-interleaved and
// de-normalised, so nothing downstream has to know how it was stored.
export function readAccessor(gltf, buffers, index) {
    const acc = gltf.accessors[index];
    const n = NUM_COMPONENTS[acc.type];
    const out = new Float64Array(acc.count * n);
    if (acc.bufferView === undefined) return out;                 // spec: all zeroes
    const view = gltf.bufferViews[acc.bufferView];
    const Ctor = COMPONENT[acc.componentType];
    if (!Ctor) throw new Error(`unknown componentType ${acc.componentType}`);
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? n * Ctor.BYTES_PER_ELEMENT;
    const buf = buffers[view.buffer];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const scale = acc.normalized ? COMPONENT_MAX[acc.componentType] : 0;
    for (let i = 0; i < acc.count; i++) {
        for (let c = 0; c < n; c++) {
            const at = base + i * stride + c * Ctor.BYTES_PER_ELEMENT;
            const v = readOne(dv, at, acc.componentType);
            out[i * n + c] = scale ? Math.max(v / scale, -1) : v;
        }
    }
    return out;
}

function readOne(dv, at, componentType) {
    if (componentType === 5120) return dv.getInt8(at);
    if (componentType === 5121) return dv.getUint8(at);
    if (componentType === 5122) return dv.getInt16(at, true);
    if (componentType === 5123) return dv.getUint16(at, true);
    if (componentType === 5125) return dv.getUint32(at, true);
    return dv.getFloat32(at, true);
}
