// spline.js — the lines a player draws (EDT.12, PLAN-editors.md §2.3).
//
// A line is its control nodes, each smooth or a corner. Smooth nodes are
// passed through by a Catmull-Rom curve; a corner is a kink. What is stored in
// the world is the curve densified — a point every metre, and more where it
// turns — so QGIS, the compiler and the steepness check see exactly what the
// player saw. A sketch is simplified back to nodes (Douglas–Peucker).
//
// Pure: points are [x, z] metres in some local frame (x east, z south), and
// `frameAt` converts from and to degrees. Node-tested (client/test/spline.test.js).

const M_LAT = 110540;

// A local metric frame around a point, and the two conversions.
export function frameAt(lon0, lat0) {
    const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    return {
        lon0, lat0, mLon,
        toXZ: (lon, lat) => [(lon - lon0) * mLon, (lat0 - lat) * M_LAT],
        toLonLat: ([x, z]) => ({ lon: lon0 + x / mLon, lat: lat0 - z / M_LAT }),
    };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The tangents a segment leaves node i and arrives at node i + 1 with:
// Catmull-Rom's at a smooth node, and at a corner or an end the segment's own
// direction — so a segment between two corners is exactly straight, and the
// curve kinks at a corner rather than rounding it.
function tangentsOf(pts, corner, i) {
    const last = pts.length - 1;
    const own = sub(pts[i + 1], pts[i]);
    const ta = i === 0 || corner[i] ? own : mul(sub(pts[i + 1], pts[i - 1]), 0.5);
    const tb = i + 1 === last || corner[i + 1] ? own : mul(sub(pts[i + 2], pts[i]), 0.5);
    return [ta, tb];
}

// A point of the cubic Hermite segment from a to b at t.
function hermite(a, b, ta, tb, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return [a[0] * h00 + ta[0] * h10 + b[0] * h01 + tb[0] * h11,
        a[1] * h00 + ta[1] * h10 + b[1] * h01 + tb[1] * h11];
}

/**
 * The curve through `nodes` ([x, z]), `corner[i]` true where node i is a kink,
 * sampled every `fine` metres. The nodes themselves are among the samples.
 */
export function curve(nodes, corner = [], fine = 0.25) {
    if (nodes.length < 2) return nodes.map((p) => [...p]);
    const out = [[...nodes[0]]];
    for (let i = 0; i + 1 < nodes.length; i++) {
        const [ta, tb] = tangentsOf(nodes, corner, i);
        const n = Math.max(1, Math.ceil(dist(nodes[i], nodes[i + 1]) / fine));
        for (let k = 1; k <= n; k++) out.push(hermite(nodes[i], nodes[i + 1], ta, tb, k / n));
    }
    return out;
}

// In scalars: it runs for every quarter-metre of a curve, and a pair of arrays
// a sample was most of what a long road cost (client/test/feel.test.js).
const turn = (a, b, c) => {
    const ux = b[0] - a[0];
    const uz = b[1] - a[1];
    const vx = c[0] - b[0];
    const vz = c[1] - b[1];
    const d = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    if (!d) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / d))) * 180 / Math.PI;
};

/**
 * What is stored: the curve with a point at least every `step` metres and
 * wherever it has turned `degrees` since the last one, whichever is finer. The
 * control nodes are kept exactly.
 */
export function densify(nodes, corner = [], { step = 1, degrees = 5 } = {}) {
    const every = Math.min(0.25, step / 4);
    const fine = curve(nodes, corner, every);
    if (fine.length < 3) return fine;
    // Which samples are the nodes: curve() ends each segment on its node, so
    // they are counted rather than looked up — a string key per sample was
    // most of the cost of a node on a long road (client/test/feel.test.js).
    const isNode = new Uint8Array(fine.length);
    for (let i = 0, at = 0; i + 1 < nodes.length; i++) {
        at += Math.max(1, Math.ceil(dist(nodes[i], nodes[i + 1]) / every));
        isNode[at] = 1;
    }
    const out = [fine[0]];
    let run = 0;
    let bent = 0;
    for (let i = 1; i < fine.length - 1; i++) {
        run += dist(fine[i - 1], fine[i]);
        bent += turn(fine[i - 1], fine[i], fine[i + 1]);
        // Kept when the next sample would be past a metre from the last kept,
        // so no two stored points are ever further apart than that.
        const full = run + dist(fine[i], fine[i + 1]) > step + 1e-9;
        if (full || bent >= degrees || isNode[i]) {
            out.push(fine[i]);
            run = 0;
            bent = 0;
        }
    }
    out.push(fine.at(-1));
    return out;
}

// How far a point is from the segment a–b, and where along it the foot falls.
export function toSegment(p, a, b) {
    const d = sub(b, a);
    const l2 = d[0] * d[0] + d[1] * d[1];
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
    const foot = add(a, mul(d, t));
    return { t, foot, d: dist(p, foot) };
}

/**
 * Douglas–Peucker: the fewest points of `pts` that stay within `tol` metres
 * of it. A hold-drag sketch becomes nodes this way.
 */
export function simplify(pts, tol = 0.5) {
    if (pts.length < 3) return pts.map((p) => [...p]);
    const keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [i, j] = stack.pop();
        let far = -1;
        let at = -1;
        for (let k = i + 1; k < j; k++) {
            const d = toSegment(pts[k], pts[i], pts[j]).d;
            if (d > far) { far = d; at = k; }
        }
        if (far > tol) {
            keep[at] = 1;
            stack.push([i, at], [at, j]);
        }
    }
    return pts.filter((_, k) => keep[k]).map((p) => [...p]);
}

export function length(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
    return l;
}

/**
 * The point of the polyline nearest `p`: the segment it is on, how far along
 * the line it is, the point itself and the distance to it.
 */
export function nearest(pts, p) {
    let best = null;
    let along = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        const s = toSegment(p, pts[i], pts[i + 1]);
        const seg = dist(pts[i], pts[i + 1]);
        if (!best || s.d < best.d) {
            best = { i, t: s.t, point: s.foot, d: s.d, along: along + seg * s.t };
        }
        along += seg;
    }
    return best;
}

/**
 * Two lines from one, at node `i` (which both keep), with the corner flags
 * carried along.
 */
export function split(nodes, corner, i) {
    if (i <= 0 || i >= nodes.length - 1) return null;
    return [{ nodes: nodes.slice(0, i + 1), corner: corner.slice(0, i + 1) },
        { nodes: nodes.slice(i), corner: corner.slice(i) }];
}

/**
 * One line from two whose ends meet (within `tol` metres): turned round as
 * needed, the meeting node kept once.
 */
export function join(a, b, tol = 1) {
    const flip = (l) => ({ nodes: [...l.nodes].reverse(), corner: [...l.corner].reverse() });
    for (const [x, y] of [[a, b], [a, flip(b)], [flip(a), b], [flip(a), flip(b)]]) {
        if (dist(x.nodes.at(-1), y.nodes[0]) <= tol) {
            return { nodes: [...x.nodes, ...y.nodes.slice(1)],
                corner: [...x.corner, ...y.corner.slice(1)] };
        }
    }
    return null;
}

export const reverse = (l) => ({ nodes: [...l.nodes].reverse(), corner: [...l.corner].reverse() });
