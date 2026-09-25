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
