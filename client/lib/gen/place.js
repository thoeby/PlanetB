// place.js — one model, on a point.
//
// A tree somebody drew as a point, a bench along a path: the catalog product
// the symbol names, standing on the ground under the point. The GLB comes
// from the tile's asset bag, by the same route an instance's does — one file
// however many points name it (client/lib/assets.js).
//
// Parameters: `model` (a product's catalogue number), `yaw` (degrees),
// `scale`, `lift` (m off the ground).

import { boundsOf, placeMeshes } from '../glbmesh.js';

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Where the feature stands: a point feature's own coordinates, or the middle
// of whatever else it is.
function spotOf(feature) {
    if (feature.points?.length) return feature.points[0];
    const ring = feature.rings?.[0];
    if (!ring?.length) return null;
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

export function run(params, feature, ctx) {
    const glb = ctx.asset(params.model);
    const spot = spotOf(feature);
    if (!glb || !spot) return null;
    const at = [spot[0], ctx.terrain.at(spot[0], spot[1]) + num(params.lift, 0), spot[1]];
    const placed = placeMeshes(glb, { at, yaw: num(params.yaw, 0) * Math.PI / 180,
        scale: num(params.scale, 1), material: params.material ?? 'asset' });
    for (const m of placed) ctx.add(m);
    return { boxes: [boxOf(placed, at)] };
}

// The box a player bumps into: the placed model's own bounds.
function boxOf(meshes, at) {
    const { min, max } = boundsOf(meshes.map((m) => ({ positions: m.positions })));
    return {
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
        yaw: 0,
        at,
    };
}
