// assemblelocal.js — a feature of the world, in one tile's own metres.
//
// Split out of client/atoms/assemble.js so that the loading half
// (assembleload.js) and the building half can both reach it. GeoJSON in the
// world's coordinates goes in; rings and lines in the tile's frame come out,
// with the point-in-polygon test the layers ask.

import { contains } from '../lib/poly.js';
import { localFromLonLat } from '../lib/tilemath.js';

const ringsOf = (geom, pt) => {
    if (geom.type === 'Polygon') return geom.coordinates.map((r) => r.map(pt));
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat().map((r) => r.map(pt));
    return [];
};

const linesOf = (geom, pt) => {
    if (geom.type === 'LineString') return [geom.coordinates.map(pt)];
    if (geom.type === 'MultiLineString') return geom.coordinates.map((l) => l.map(pt));
    return [];
};

// GeoJSON closes a ring by repeating its first point; nothing here wants that.
const open = (ring) => (ring.length > 1
    && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? ring.slice(0, -1) : ring);

export function toLocal(frame, feature) {
    const pt = ([lon, lat]) => {
        const p = localFromLonLat(frame, lon, lat);
        return [p.x, p.z];
    };
    const rings = ringsOf(feature.geom, pt).map(open).filter((r) => r.length >= 3);
    return {
        id: feature.id,
        kind: feature.kind,
        props: feature.props ?? {},
        rings,
        lines: linesOf(feature.geom, pt),
        contains: (x, z) => contains(rings, x, z),
    };
}
