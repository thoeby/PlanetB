// linesnap.js — what a line's node can snap to on this land, gathered from
// what Lines holds (EDT.14): its own lines' ends, the neighbours' (their
// ghosts, EDT.18), the land's boundary, the edges of areas drawn on it and
// round it. The arithmetic is client/lib/snap.js.

import { readFeatures } from './edit.js';
import { frameAt } from '../lib/spline.js';
import { snapPoint } from '../lib/snap.js';
import { ringsOf } from './sculpt.js';

// How many pixels of the screen a snap reaches across.
const REACH_PX = 12;

// The neighbours' lines and every area's edges around this land, read once
// when the land is opened: tile_world, which everybody may read.
export async function aroundLand(area) {
    const b = area.bbox;
    const pad = 0.003;
    const got = await readFeatures({ west: b.west - pad, south: b.south - pad,
        east: b.east + pad, north: b.north + pad }).catch(() => ({ features: [] }));
    const ghosts = [];
    const edges = [];
    for (const f of got.features ?? []) {
        const t = f.geom?.type ?? f.geometry?.type;
        const geom = f.geom ?? f.geometry;
        if ((t === 'LineString' || t === 'MultiLineString') && f.area_id !== area.id) {
            const coords = t === 'LineString' ? geom.coordinates : geom.coordinates[0];
            ghosts.push({ id: f.id, kind: f.kind, props: f.props ?? {},
                nodes: coords.map(([lon, lat]) => ({ lon, lat })),
                corner: coords.map(() => true) });
        }
        if (t === 'Polygon' || t === 'MultiPolygon') {
            const rings = t === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
            for (const ring of rings) {
                for (let i = 0; i + 1 < ring.length; i++) edges.push([ring[i], ring[i + 1]]);
            }
        }
    }
    return { ghosts, edges };
}

/**
 * Where a node dropped at `g` lands: {lon, lat, hit} or {refused}. `e` is the
 * pointer event (Ctrl), `metresPerPx` how much ground a pixel is.
 */
export function snapNode(state, g, e, { grid = 0, metresPerPx = 0.5 } = {}) {
    const area = state.lines?.area;
    if (!area || !g) return { refused: false, lon: g?.lon, lat: g?.lat, hit: null };
    const f = frameAt(g.lon, g.lat);
    const xz = (p) => f.toXZ(p.lon ?? p[0], p.lat ?? p[1]);
    const ends = [];
    for (const l of [...(state.lines.live ?? []), ...(state.ghosts ?? [])]) {
        if (l.nodes.length < 2) continue;
        ends.push({ p: xz(l.nodes[0]), kind: l.kind }, { p: xz(l.nodes.at(-1)), kind: l.kind });
    }
    const prev = state.drawing?.nodes.at(-1);
    const got = snapPoint(xz(g), {
        ends, edges: (state.edges ?? []).map(([a, b]) => [xz(a), xz(b)]),
        land: ringsOf(area.outline).map((r) => r.map(xz)),
        prev: prev ? xz(prev) : null, angle: Boolean(e?.ctrlKey || e?.metaKey), grid,
        tol: REACH_PX * metresPerPx,
    });
    if (got.refused) return { refused: true };
    const at = f.toLonLat(got.p);
    return { lon: at.lon, lat: at.lat, hit: got.hit };
}

/**
 * Follow contour (EDT.17, PLAN-editors idea 22): the point near `g` where the
 * ground is at height `h0`, walked down or up the slope from `g`. A path
 * across a hillside, a channel, a terrace edge — without touching the ground.
 * Null where the ground there is flat or there is none.
 */
export function onContour(g, h0, heightAt, { most = 40 } = {}) {
    const f = frameAt(g.lon, g.lat);
    const h = (p) => {
        const q = f.toLonLat(p);
        return heightAt(q.lon, q.lat);
    };
    let p = [0, 0];
    for (let k = 0; k < 12; k++) {
        const here = h(p);
        if (here === null) return null;
        const gx = (h([p[0] + 0.5, p[1]]) - h([p[0] - 0.5, p[1]]));
        const gz = (h([p[0], p[1] + 0.5]) - h([p[0], p[1] - 0.5]));
        const g2 = gx * gx + gz * gz;
        if (!(g2 > 1e-8)) return null;
        const step = (here - h0) / g2;
        p = [p[0] - gx * step, p[1] - gz * step];
        if (Math.hypot(p[0], p[1]) > most) return null;
        if (Math.abs(here - h0) < 0.01) break;
    }
    const at = f.toLonLat(p);
    return { lon: at.lon, lat: at.lat };
}
