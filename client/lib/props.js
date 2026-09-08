// props.js — everything that stands on the terrain: road surfaces, extruded
// footprints and their colliders, water planes, and the trees a forest is
// scattered with.
//
// Trees are proxies — a trunk and a canopy — until WP4.1 gives the catalog real
// GLBs to place by SAN. Roofs are built on the footprint's oriented bounding
// box rather than on the polygon itself: a gable over an arbitrary outline is a
// straight skeleton, and at 110 m a tile away nobody is counting its edges.

import { Mesh, normalOf } from './mesh.js';
import { earcut, ringArea, scatter } from './poly.js';

const UP = [0, 1, 0];

export const MATERIALS = {
    terrain: { color: [0.35, 0.4, 0.3], roughness: 1 },
    road: { color: [0.22, 0.22, 0.24], roughness: 0.9 },
    wall: { color: [0.72, 0.69, 0.64], roughness: 0.8 },
    roof: { color: [0.45, 0.26, 0.2], roughness: 0.8 },
    water: { color: [0.16, 0.29, 0.42], roughness: 0.1 },
    trunk: { color: [0.28, 0.2, 0.14], roughness: 1 },
    canopy: { color: [0.16, 0.34, 0.14], roughness: 1 },
};

// ------------------------------------------------------------------- roads

export function roadMesh(roads, terrain) {
    const m = new Mesh('road');
    for (const road of roads) {
        const half = road.width / 2;
        for (const { a, b } of road.segments) {
            const dx = b[0] - a[0];
            const dz = b[1] - a[1];
            const len = Math.hypot(dx, dz) || 1;
            const nx = -dz / len * half;
            const nz = dx / len * half;
            const lift = 0.06;
            const quad = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz],
                [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
            m.face(quad.map(([x, z]) => [x, terrain.at(x, z) + lift, z]), UP,
                MATERIALS.road.color);
        }
    }
    return m;
}

// ------------------------------------------------------------------ water

export function waterMesh(waters, terrain) {
    const m = new Mesh('water');
    for (const w of waters) {
        const ring = w.rings[0];
        if (!ring || ring.length < 3) continue;
        const level = Math.min(...ring.map((p) => terrain.at(p[0], p[1]))) - 0.05;
        const idx = earcut(ring);
        const base = m.vertexCount;
        for (const [x, z] of ring) m.vertex([x, level, z], UP, MATERIALS.water.color);
        for (let i = 0; i < idx.length; i += 3) {
            m.tri(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
        }
    }
    return m;
}

// -------------------------------------------------------------- footprints

// The longest edge decides which way the building faces; the roof and the
// collider are both built in that frame.
function orient(ring) {
    let best = 0;
    let yaw = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > best) { best = len; yaw = Math.atan2(b[1] - a[1], b[0] - a[0]); }
    }
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of ring) {
        const rx = x * c - z * s;
        const rz = x * s + z * c;
        box[0] = Math.min(box[0], rx); box[1] = Math.min(box[1], rz);
        box[2] = Math.max(box[2], rx); box[3] = Math.max(box[3], rz);
    }
    const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    return {
        yaw,
        half: [(box[2] - box[0]) / 2, (box[3] - box[1]) / 2],
        centre: [centre[0] * c + centre[1] * s, -centre[0] * s + centre[1] * c],
        // Local (long, across) offsets back into the tile frame.
        to: (u, v) => [centre[0] + u, centre[1] + v],
        world: ([rx, rz]) => [rx * c + rz * s, -rx * s + rz * c],
    };
}

function roofShape(shape) {
    if (shape === 'gabled' || shape === 'gable') return 'gable';
    if (shape === 'hipped' || shape === 'pyramidal' || shape === 'hip') return 'hip';
    return 'flat';
}

function gable(m, o, top, colour) {
    const [hx, hz] = o.half;
    const ridge = top + Math.min(hz, 4);
    const p = (u, v, h) => { const [x, z] = o.world(o.to(u, v)); return [x, h, z]; };
    const corners = [p(-hx, -hz, top), p(hx, -hz, top), p(hx, hz, top), p(-hx, hz, top)];
    const ridgeA = p(-hx, 0, ridge);
    const ridgeB = p(hx, 0, ridge);
    m.face([corners[0], corners[1], ridgeB, ridgeA],
        normalOf(corners[0], corners[1], ridgeB), colour);
    m.face([corners[2], corners[3], ridgeA, ridgeB],
        normalOf(corners[2], corners[3], ridgeA), colour);
    m.face([corners[1], corners[2], ridgeB], normalOf(corners[1], corners[2], ridgeB), colour);
    m.face([corners[3], corners[0], ridgeA], normalOf(corners[3], corners[0], ridgeA), colour);
}

function hip(m, o, top, colour) {
    const [hx, hz] = o.half;
    const p = (u, v, h) => { const [x, z] = o.world(o.to(u, v)); return [x, h, z]; };
    const apex = p(0, 0, top + Math.min(hx, hz, 5));
    const c = [p(-hx, -hz, top), p(hx, -hz, top), p(hx, hz, top), p(-hx, hz, top)];
    for (let i = 0; i < 4; i++) {
        const a = c[i];
        const b = c[(i + 1) % 4];
        m.face([a, b, apex], normalOf(a, b, apex), colour);
    }
}

export function buildings(footprints, terrain) {
    const walls = new Mesh('wall');
    const roofs = new Mesh('roof');
    const boxes = [];
    for (const f of footprints) {
        const ring = f.rings[0];
        if (!ring || ring.length < 3) continue;
        const heights = ring.map((p) => terrain.at(p[0], p[1]));
        const base = Math.min(...heights) - 0.5;
        const tall = Number(f.props?.height)
            || Number(f.props?.levels) * 3 || 6;
        const top = base + tall;
        wallsOf(walls, ring, base, top);
        const o = orient(ring);
        const shape = roofShape(f.props?.roof);
        if (shape === 'gable') gable(roofs, o, top, MATERIALS.roof.color);
        else if (shape === 'hip') hip(roofs, o, top, MATERIALS.roof.color);
        else flatRoof(roofs, ring, top);
        boxes.push({
            center: [o.centre[0], (base + top) / 2, o.centre[1]],
            half: [o.half[0], (top - base) / 2, o.half[1]],
            yaw: -o.yaw,
        });
    }
    return { walls, roofs, boxes };
}

function wallsOf(m, ring, base, top) {
    const outward = ringArea(ring) > 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        const n = [-dz / len * outward, 0, dx / len * outward];
        m.face([[a[0], base, a[1]], [b[0], base, b[1]],
            [b[0], top, b[1]], [a[0], top, a[1]]], n, MATERIALS.wall.color);
    }
}

function flatRoof(m, ring, top) {
    const idx = earcut(ring);
    const base = m.vertexCount;
    for (const [x, z] of ring) m.vertex([x, top, z], UP, MATERIALS.roof.color);
    for (let i = 0; i < idx.length; i += 3) {
        m.tri(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
    }
}

// ------------------------------------------------------------------- trees

const SPECIES = {
    needleleaved: { sides: 6, taper: 0.28, tall: [12, 22], color: [0.12, 0.28, 0.16] },
    broadleaved: { sides: 6, taper: 0.55, tall: [9, 17], color: [0.2, 0.4, 0.16] },
};

// One canopy cone and one square trunk per tree, scattered by Poisson disk. The
// radius is set by the caller from the tile's size, so a z14 tile does not try
// to grow a hundred thousand trees.
export function trees(forests, terrain, random, radius) {
    const trunks = new Mesh('trunk');
    const canopies = new Mesh('canopy');
    let count = 0;
    for (const f of forests) {
        const kind = f.props?.leaf_type === 'broadleaved' ? 'broadleaved' : 'needleleaved';
        const s = SPECIES[kind];
        for (const [x, z] of scatter(f.rings, radius, random)) {
            const ground = terrain.at(x, z);
            const tall = s.tall[0] + random() * (s.tall[1] - s.tall[0]);
            const wide = tall * s.taper;
            cone(canopies, [x, ground + tall * 0.35, z], wide / 2, tall * 0.75, s.sides,
                s.color.map((c) => c * (0.85 + random() * 0.3)));
            trunk(trunks, x, z, ground, tall * 0.4, wide * 0.06);
            count += 1;
        }
    }
    return { trunks, canopies, count };
}

function cone(m, base, r, tall, sides, colour) {
    const apex = [base[0], base[1] + tall, base[2]];
    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const p0 = [base[0] + Math.cos(a0) * r, base[1], base[2] + Math.sin(a0) * r];
        const p1 = [base[0] + Math.cos(a1) * r, base[1], base[2] + Math.sin(a1) * r];
        m.face([p0, p1, apex], normalOf(p0, p1, apex), colour);
    }
}

function trunk(m, x, z, ground, tall, r) {
    const c = MATERIALS.trunk.color;
    for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2;
        const a1 = ((i + 1) / 4) * Math.PI * 2;
        const p0 = [x + Math.cos(a0) * r, ground, z + Math.sin(a0) * r];
        const p1 = [x + Math.cos(a1) * r, ground, z + Math.sin(a1) * r];
        m.face([p0, p1, [p1[0], ground + tall, p1[2]], [p0[0], ground + tall, p0[2]]],
            normalOf(p0, p1, [p1[0], ground + tall, p1[2]]), c);
    }
}
