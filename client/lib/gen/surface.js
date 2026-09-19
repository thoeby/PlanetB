// surface.js — something laid on the ground along a line, or over an area.
//
// Along a line it is a road: the corridor is cut into the hill first
// (`prepare`), and the surface is laid on the cut ground afterwards. Over an
// area it is a sheet at one level — what a lake is.
//
// Parameters: `width` (m), `lift` (m above the ground), `colour`, `profile`
// (a cross-section product, FND.5 — laid instead of the plain strip when the
// symbol names one), `flat` and `drop` for the area case.

import { earcut } from '../poly.js';
import { MATERIALS } from '../props.js';
import { stripsOf } from '../product.js';

const UP = [0, 1, 0];

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// The centreline, its width, and the ground under it smoothed: the ground
// under a road is not as bumpy as a 30 m DEM says it is.
export function roadsOf(params, feature, terrain) {
    const width = num(params.width, 5);
    const out = [];
    for (const line of feature.lines ?? []) {
        if (line.length < 2) continue;
        const raw = line.map(([x, z]) => terrain.at(x, z));
        const h = raw.map((_, i) => (raw[Math.max(i - 1, 0)] + raw[i]
            + raw[Math.min(i + 1, raw.length - 1)]) / 3);
        const segments = [];
        for (let i = 0; i + 1 < line.length; i++) {
            segments.push({ a: line[i], b: line[i + 1], ha: h[i], hb: h[i + 1] });
        }
        out.push({ width, segments });
    }
    return out;
}

// The roads this tile has to cut, gathered before anything is drawn.
export function prepare(params, feature, ctx) {
    if (!feature.lines?.length) return null;
    const roads = roadsOf(params, feature, ctx.terrain);
    ctx.roads.push(...roads);
    ctx.roadsBy.set(feature.id, roads);
    return null;
}

export function run(params, feature, ctx) {
    if (feature.lines?.length) return alongLine(params, feature, ctx);
    return overArea(params, feature, ctx);
}

// The strips of the symbol's cross-section, or one strip the whole width.
function stripsFor(params, ctx) {
    const profile = params.profile ? ctx.product(params.profile) : null;
    if (!profile) {
        return [{ offset: 0, width: num(params.width, 5), height: 0,
            colour: params.colour ?? MATERIALS.road.color }];
    }
    return stripsOf(profile).map((s) => ({ ...s,
        colour: params.colour ?? MATERIALS.road.color }));
}

function alongLine(params, feature, ctx) {
    const mesh = ctx.mesh(params.material ?? 'road');
    const lift = num(params.lift, 0.06);
    const strips = stripsFor(params, ctx);
    for (const road of ctx.roadsBy.get(feature.id) ?? []) {
        for (const { a, b } of road.segments) {
            for (const strip of strips) layStrip(mesh, ctx.terrain, a, b, strip, lift);
        }
    }
    return null;
}

// One strip of the cross-section over one segment: a quad `width` wide,
// `offset` from the centre, `lift` (plus the strip's own height) above the
// ground it is laid on.
function layStrip(mesh, terrain, a, b, strip, lift) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const from = strip.offset - strip.width / 2;
    const to = strip.offset + strip.width / 2;
    const up = lift + (strip.height ?? 0);
    const corner = (p, k) => [p[0] + nx * k, p[1] + nz * k];
    const quad = [corner(a, to), corner(b, to), corner(b, from), corner(a, from)];
    mesh.face(quad.map(([x, z]) => [x, terrain.at(x, z) + up, z]), UP, strip.colour);
}

// A sheet over an area, at one level: the lowest ground it covers, less
// `drop`, so a lake sits in its own basin.
function overArea(params, feature, ctx) {
    const ring = feature.rings?.[0];
    if (!ring || ring.length < 3) return null;
    const mesh = ctx.mesh(params.material ?? 'water');
    const level = Math.min(...ring.map((p) => ctx.terrain.at(p[0], p[1])))
        - num(params.drop, 0.05);
    const colour = params.colour ?? MATERIALS.water.color;
    const idx = earcut(ring);
    const base = mesh.vertexCount;
    for (const [x, z] of ring) mesh.vertex([x, level, z], UP, colour);
    for (let i = 0; i < idx.length; i += 3) {
        mesh.tri(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
    }
    return null;
}
