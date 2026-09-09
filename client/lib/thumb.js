// thumb.js — the catalog's picture of an asset, drawn in the tab that uploads
// it. The server renders nothing (Invariant 9), so a thumbnail is one more
// thing the client makes and PUTs.
//
// It reads the canonical GLB, not the file the user picked: what the catalog
// shows is what the world will place. The shading is `frame`'s — the same fixed
// sun and vertex-colour renderer — so an asset's thumbnail looks like the asset
// does in a tile.

import { Renderer, toWebp } from './render.js';
import { parseGlb, readAccessor, resolveBuffers } from './glb.js';

export const THUMB_SIZE = 256;
export const ALGO = 'thumb-v1';

const WHITE = [0.82, 0.82, 0.82];

// Colour comes from the material's base colour factor: canon-v1 keeps no vertex
// colours, and this renderer has no textures.
function colourOf(material) {
    const f = material?.pbrMetallicRoughness?.baseColorFactor;
    return f ? [f[0], f[1], f[2]] : WHITE;
}

// One mesh per primitive, in lib/mesh.js's unpacked shape.
export function meshesOf(glb) {
    const { json, bin } = parseGlb(glb);
    const buffers = resolveBuffers(json, bin);
    return json.meshes[0].primitives.map((prim) => {
        const positions = Float32Array.from(readAccessor(json, buffers, prim.attributes.POSITION));
        const normals = Float32Array.from(readAccessor(json, buffers, prim.attributes.NORMAL));
        const colour = colourOf(json.materials?.[prim.material]);
        const colors = new Float32Array(positions.length);
        for (let i = 0; i < colors.length; i += 3) colors.set(colour, i);
        return { positions, normals, colors,
            indices: Uint32Array.from(readAccessor(json, buffers, prim.indices)) };
    });
}

export function boundsOf(meshes) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
        for (let i = 0; i < m.positions.length; i += 3) {
            for (let c = 0; c < 3; c++) {
                min[c] = Math.min(min[c], m.positions[i + c]);
                max[c] = Math.max(max[c], m.positions[i + c]);
            }
        }
    }
    return { min, max };
}

// Three-quarter view from above, framed on the model's own bounding sphere, so
// a lamppost and a cathedral both fill the picture.
export function thumbCamera(meshes) {
    const { min, max } = boundsOf(meshes);
    const centre = min.map((v, c) => (v + max[c]) / 2);
    const radius = Math.max(0.25, Math.hypot(...max.map((v, c) => (v - min[c]) / 2)));
    const distance = radius * 2.6;
    return {
        position: [centre[0] + distance * 0.62, centre[1] + distance * 0.55,
            centre[2] + distance * 0.56],
        target: centre, up: [0, 1, 0], fov: 40, near: Math.max(0.01, distance * 0.05),
        far: distance * 8,
    };
}

// canvas(w, h) makes an OffscreenCanvas — the same one work.js hands an atom.
export async function renderThumb(glb, canvas, size = THUMB_SIZE) {
    const meshes = meshesOf(glb);
    const cam = thumbCamera(meshes);
    const renderer = new Renderer(canvas(size, size), size);
    renderer.upload(meshes);
    const rgba = renderer.draw(cam, { near: cam.near, far: cam.far });
    return toWebp(rgba, size, canvas);
}
