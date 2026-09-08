// mesh.js — one mesh per material, accumulated as plain arrays and packed into
// the single buffer `assemble` puts in its tar. `frame` reads it back and hands
// it to PlayCanvas; nothing in between needs to know what a mesh is.

export class Mesh {
    constructor(material) {
        this.material = material;
        this.positions = [];
        this.normals = [];
        this.colors = [];
        this.indices = [];
    }

    get vertexCount() { return this.positions.length / 3; }

    vertex(p, n, c) {
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(n[0], n[1], n[2]);
        this.colors.push(c[0], c[1], c[2]);
        return this.vertexCount - 1;
    }

    tri(a, b, c) { this.indices.push(a, b, c); }

    // A flat, wound-once polygon: the normal is the same for every vertex, so
    // the surface reads as one plane however it is lit.
    face(points, normal, colour) {
        const base = this.vertexCount;
        for (const p of points) this.vertex(p, normal, colour);
        for (let i = 2; i < points.length; i++) this.tri(base, base + i - 1, base + i);
    }
}

export const normalOf = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
};

// One Float32Array of positions, normals and colours per mesh, then a Uint32
// index run — in that order, so scene.json only has to record offsets.
export function packMeshes(meshes) {
    const parts = [];
    const specs = [];
    let at = 0;
    const put = (arr) => {
        parts.push(arr);
        const spec = { offset: at, count: arr.length };
        at += arr.byteLength;
        return spec;
    };
    for (const m of meshes) {
        specs.push({
            material: m.material,
            positions: put(new Float32Array(m.positions)),
            normals: put(new Float32Array(m.normals)),
            colors: put(new Float32Array(m.colors)),
            indices: put(new Uint32Array(m.indices)),
        });
    }
    const out = new Uint8Array(at);
    let off = 0;
    for (const p of parts) {
        out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), off);
        off += p.byteLength;
    }
    return { bin: out, specs };
}

export function unpackMeshes(bin, specs) {
    const buf = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
    const read = (Type, spec) =>
        new Type(buf.buffer.slice(buf.byteOffset + spec.offset,
            buf.byteOffset + spec.offset + spec.count * Type.BYTES_PER_ELEMENT));
    return specs.map((s) => ({
        material: s.material,
        positions: read(Float32Array, s.positions),
        normals: read(Float32Array, s.normals),
        colors: read(Float32Array, s.colors),
        indices: read(Uint32Array, s.indices),
    }));
}
