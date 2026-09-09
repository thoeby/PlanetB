// thumb.js — the catalog's picture of an asset, drawn in the tab that uploads
// it. The server renders nothing (Invariant 9), so a thumbnail is one more
// thing the client makes and PUTs.
//
// It reads the canonical GLB, not the file the user picked: what the catalog
// shows is what the world will place. The shading is `frame`'s — the same fixed
// sun and vertex-colour renderer — so an asset's thumbnail looks like the asset
// does in a tile.

import { Renderer, toWebp } from './render.js';
import { boundsOf, meshesOf } from './glbmesh.js';

export const THUMB_SIZE = 256;
export const ALGO = 'thumb-v1';

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
