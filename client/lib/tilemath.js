// tilemath.js — the client-side mirror of db/0004_tiles.sql.
//
// Every function here must agree with its SQL counterpart bit for bit; the
// fixture in client/test/fixtures/tilemath.json is exported from the database
// and client/test/tilemath.test.js is what keeps the two honest. Constants are
// written in the same algebraic form PostgreSQL uses (multiply by
// RADIANS_PER_DEGREE, divide by it for the inverse) so the roundings match.

export const RAD_PER_DEG = 0.0174532925199432957692;

// The Web-Mercator cut-off, identical to the literal in tile_y().
export const MAX_LAT = 85.0511287798066;

// Invariant: tiles exist on even zooms only, 6…18 (ARCHITECTURE §2).
export const MIN_ZOOM = 6;
export const MAX_ZOOM = 18;
export const ZOOMS = [6, 8, 10, 12, 14, 16, 18];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function tileX(lon, z) {
    const n = 2 ** z;
    return clamp(Math.floor((lon + 180) / 360 * n), 0, n - 1);
}

export function tileY(lat, z) {
    const n = 2 ** z;
    const phi = clamp(lat, -MAX_LAT, MAX_LAT) * RAD_PER_DEG;
    return clamp(
        Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n), 0, n - 1);
}

// Matches st_makeenvelope(...) in tile_bbox(): west/south/east/north, 4326.
export function tileBbox(z, x, y) {
    const n = 2 ** z;
    return {
        west: x / n * 360 - 180,
        south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) / RAD_PER_DEG,
        east: (x + 1) / n * 360 - 180,
        north: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / RAD_PER_DEG,
    };
}

export function tileCenter(z, x, y) {
    const b = tileBbox(z, x, y);
    return { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

// ------------------------------------------------------------- ladder walking

export function parent(z, x, y) {
    if (z <= MIN_ZOOM) return null;
    return { z: z - 2, x: Math.floor(x / 4), y: Math.floor(y / 4) };
}

export function ancestors(z, x, y) {
    const out = [];
    for (let p = parent(z, x, y); p; p = parent(p.z, p.x, p.y)) out.push(p);
    return out;
}

// The 16 grandchildren, in the (dx, dy) order child_sogs() generates them.
export function children(z, x, y) {
    if (z >= MAX_ZOOM) return [];
    const out = [];
    for (let dx = 0; dx < 4; dx++) {
        for (let dy = 0; dy < 4; dy++) {
            out.push({ z: z + 2, x: x * 4 + dx, y: y * 4 + dy });
        }
    }
    return out;
}

// ------------------------------------------------------------------- geometry
//
// Geometries are GeoJSON-shaped: {type, coordinates}. Point, LineString and
// Polygon (with holes) are what feature.geom ever holds; a third ordinate is
// carried by GeometryZ rows and ignored here, exactly as st_intersects does.

function ringsOf(g) {
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    throw new Error(`not a polygon: ${g.type}`);
}

function eachSegment(g, fn) {
    const lines = g.type === 'LineString' ? [g.coordinates]
        : g.type === 'MultiLineString' ? g.coordinates
            : ringsOf(g).flat();
    for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
            if (fn(line[i - 1], line[i])) return true;
        }
    }
    return false;
}

export function envelope(g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const visit = (c) => {
        if (typeof c[0] === 'number') {
            x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
            y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
        } else {
            for (const k of c) visit(k);
        }
    };
    visit(g.coordinates);
    return { x0, y0, x1, y1 };
}

const inBox = (p, b) =>
    p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north;

// Liang–Barsky, inclusive: touching the box counts, as it does in PostGIS.
function segmentHitsBox(a, c, b) {
    if (inBox(a, b) || inBox(c, b)) return true;
    const dx = c[0] - a[0], dy = c[1] - a[1];
    let t0 = 0, t1 = 1;
    const edges = [[-dx, a[0] - b.west], [dx, b.east - a[0]],
        [-dy, a[1] - b.south], [dy, b.north - a[1]]];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) return false;
        } else {
            const r = q / p;
            if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
            else { if (r < t0) return false; if (r < t1) t1 = r; }
        }
    }
    return t0 <= t1;
}

// Ray casting. Only ever asked about points strictly inside or outside: a point
// on the boundary is already covered by the edge test in polygonHitsBox().
function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > p[1]) !== (yj > p[1])
            && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function pointInPolygon(p, rings) {
    if (!pointInRing(p, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false;
    return true;
}

function polygonHitsBox(g, b) {
    if (eachSegment(g, (a, c) => segmentHitsBox(a, c, b))) return true;
    // No edge crosses it, so the box is either wholly inside or wholly outside.
    const corner = [b.west, b.south];
    return ringsOf(g).some((rings) => pointInPolygon(corner, rings));
}

export function intersectsBbox(g, b) {
    switch (g.type) {
        case 'Point': return inBox(g.coordinates, b);
        case 'MultiPoint': return g.coordinates.some((p) => inBox(p, b));
        case 'LineString':
        case 'MultiLineString': return eachSegment(g, (a, c) => segmentHitsBox(a, c, b));
        case 'Polygon':
        case 'MultiPolygon': return polygonHitsBox(g, b);
        case 'GeometryCollection': return g.geometries.some((k) => intersectsBbox(k, b));
        default: throw new Error(`unsupported geometry: ${g.type}`);
    }
}

// The mirror of tiles_for_geom(g, min_z, max_z): candidates from the envelope,
// then the same st_intersects filter. Rows come back in (z, x, y) order.
export function tilesForGeom(g, minZ, maxZ) {
    const e = envelope(g);
    const out = [];
    for (let z = minZ; z <= maxZ; z += 2) {
        for (let x = tileX(e.x0, z); x <= tileX(e.x1, z); x++) {
            for (let y = tileY(e.y1, z); y <= tileY(e.y0, z); y++) {
                if (intersectsBbox(g, tileBbox(z, x, y))) out.push({ z, x, y });
            }
        }
    }
    return out;
}

// ----------------------------------------------------------- local tile frame
//
// ARCHITECTURE §2: origin = tile centre at DEM height, X east, Y up, Z south,
// metres. Z south rather than north keeps the frame right-handed and Y-up, the
// convention PlayCanvas and glTF already use.

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

function primeVertical(sinLat) {
    return WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
}

export function geodeticToEcef(lon, lat, h) {
    const lam = lon * RAD_PER_DEG, phi = lat * RAD_PER_DEG;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const n = primeVertical(sp);
    return [
        (n + h) * cp * Math.cos(lam),
        (n + h) * cp * Math.sin(lam),
        (n * (1 - WGS84_E2) + h) * sp,
    ];
}

export function ecefToGeodetic([x, y, z]) {
    const lon = Math.atan2(y, x) / RAD_PER_DEG;
    const p = Math.hypot(x, y);
    const ep2 = WGS84_E2 / (1 - WGS84_E2);
    const b = WGS84_A * Math.sqrt(1 - WGS84_E2);
    const th = Math.atan2(z * WGS84_A, p * b);
    const phi = Math.atan2(
        z + ep2 * b * Math.sin(th) ** 3,
        p - WGS84_E2 * WGS84_A * Math.cos(th) ** 3);
    const h = p / Math.cos(phi) - primeVertical(Math.sin(phi));
    return { lon, lat: phi / RAD_PER_DEG, h };
}

// The tile's own frame: its centre, lifted to the DEM height the manifest
// carries. `h` defaults to 0 for tiles whose manifest has no origin yet.
export function tileFrame(z, x, y, h = 0) {
    const c = tileCenter(z, x, y);
    return { lon: c.lon, lat: c.lat, h };
}

export function localFromLonLat(origin, lon, lat, h = 0) {
    const [ox, oy, oz] = geodeticToEcef(origin.lon, origin.lat, origin.h ?? 0);
    const [px, py, pz] = geodeticToEcef(lon, lat, h);
    const dx = px - ox, dy = py - oy, dz = pz - oz;
    const lam = origin.lon * RAD_PER_DEG, phi = (origin.lat ?? 0) * RAD_PER_DEG;
    const sl = Math.sin(lam), cl = Math.cos(lam);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    return {
        x: -sl * dx + cl * dy,
        y: cp * cl * dx + cp * sl * dy + sp * dz,
        z: sp * cl * dx + sp * sl * dy - cp * dz,
    };
}

export function lonLatFromLocal(origin, { x, y, z }) {
    const lam = origin.lon * RAD_PER_DEG, phi = (origin.lat ?? 0) * RAD_PER_DEG;
    const sl = Math.sin(lam), cl = Math.cos(lam);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const [ox, oy, oz] = geodeticToEcef(origin.lon, origin.lat, origin.h ?? 0);
    return ecefToGeodetic([
        ox - sl * x + cp * cl * y + sp * cl * z,
        oy + cl * x + cp * sl * y + sp * sl * z,
        oz + sp * y - cp * z,
    ]);
}
