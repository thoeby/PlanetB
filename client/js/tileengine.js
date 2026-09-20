// tileengine.js — the three things in the tile streamer that read PlayCanvas's
// own fields rather than the world's.
//
// Split out of client/js/tiles.js, which they were always part of and which
// re-exports them. They are kept together because they are one liability: the
// engine is pinned (tools/vendor.sh) and these are what a version bump can
// break without saying so.

import * as tm from '../lib/tilemath.js';

// The frustum is built here from the camera node's current transform rather
// than read off the component: the engine's frustum, and its view matrix, are
// the ones it last rendered with, a frame behind, and a selection made with
// them culls against where the camera was. `pc` is the engine; without it the
// rendered frustum is used.
let scratch = null;

export function cameraState(cameraEntity, screenH, pc = null) {
    const cc = cameraEntity.camera;
    const p = cameraEntity.getPosition();
    let d = cc.frustum.planeData;
    if (pc) {
        scratch ??= { frustum: new pc.Frustum(), view: new pc.Mat4(), mat: new pc.Mat4() };
        scratch.view.copy(cameraEntity.getWorldTransform()).invert();
        scratch.frustum.setFromMat4(scratch.mat.mul2(cc.projectionMatrix, scratch.view));
        d = scratch.frustum.planeData;
    }
    const planes = [];
    for (let i = 0; i < 6; i++) planes.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
    return {
        position: { x: p.x, y: p.y, z: p.z },
        planes, screenH, fovY: cc.fov * tm.RAD_PER_DEG,
    };
}

// Whether a loaded asset's splats are on the device.
//
// A single-level .sog is ready when its splats are decoded. An octree asset is
// ready when its *index* parses; the file it names is fetched afterwards by the
// octree's own loader. A tile's octree names exactly one file, so file 0 is the
// tile. These are the engine fields this file depends on (PlayCanvas 2.22,
// pinned by tools/vendor.sh): re-read this one function on a version bump.
export function splatsHere(entry) {
    const resource = entry?.asset?.resource;
    if (!resource) return false;
    const octree = resource.octree;
    return octree ? Boolean(octree.getFileResource(0)) : true;
}

// How long a placed tile is given to produce its splats before it is counted
// as drawing anyway, with a complaint. The octree's loader retries twice and
// then puts the url aside silently — nothing fires an error this file could
// hear — so without this a 404 on one .sog would wedge refine, coarsen and the
// swap for ever. It degrades the picture; it cannot stop the world.
export const RESIDENT_MS = 10000;
