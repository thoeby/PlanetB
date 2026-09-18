// repeat.js — a piece laid again and again along a line.
//
// A kerb, a guard rail, a row of lamps. A **repeating piece** (FND.5) is
// measured along X and laid end to end, the last one scaled to fit what is
// left so the run ends where the line does; a **model** is put down every
// `spacing` metres instead, standing upright.
//
// Parameters: `segment` or `model` (a product), `spacing` (m, models only),
// `side` (left · right · both · centre), `offset` (m from the centreline),
// `lift`, and whether it `follows` the ground or is laid level.

import { boundsOf, placeMeshes } from '../glbmesh.js';

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

const SIDES = { left: [-1], right: [1], both: [-1, 1], centre: [0] };

// Every point along the line, and the direction the piece faces there.
function walk(line, step) {
    const out = [];
    let carry = 0;
    for (let i = 0; i + 1 < line.length; i++) {
        const [a, b] = [line[i], line[i + 1]];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len <= 0) continue;
        const yaw = Math.atan2(dx, dz);
        for (let at = carry; at < len; at += step) {
            out.push({ x: a[0] + dx * (at / len), z: a[1] + dz * (at / len), yaw });
        }
        carry = (carry - len) % step;
        if (carry < 0) carry += step;
    }
    return out;
}

// How long one piece is along X — a repeating piece's whole reason for being
// measured (client/lib/product.js).
const lengthOf = (glb) => {
    const { min, max } = boundsOf(placeMeshes(glb, { at: [0, 0, 0] })
        .map((m) => ({ positions: m.positions })));
    return Math.max(0.1, max[0] - min[0]);
};

export function run(params, feature, ctx) {
    const glb = ctx.asset(params.segment ?? params.model);
    if (!glb || !feature.lines?.length) return null;
    const step = params.segment ? lengthOf(glb) : Math.max(0.5, num(params.spacing, 25));
    const sides = SIDES[String(params.side ?? 'centre')] ?? SIDES.centre;
    const offset = num(params.offset, 0);
    const lift = num(params.lift, 0);
    for (const line of feature.lines) {
        for (const side of sides) {
            for (const at of walk(line, step)) {
                const x = at.x + Math.cos(at.yaw) * offset * side;
                const z = at.z - Math.sin(at.yaw) * offset * side;
                const placed = placeMeshes(glb, {
                    at: [x, ctx.terrain.at(x, z) + lift, z],
                    yaw: at.yaw, scale: num(params.scale, 1),
                    material: params.material ?? 'asset',
                });
                for (const m of placed) ctx.add(m);
            }
        }
    }
    return null;
}
