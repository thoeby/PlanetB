// sculptbrush.js — what each brush does to the grid (FND.9, EDT.7).
//
// Every one of them writes relative metres into `Shaping`'s grid and nothing
// else: a dab is a function of where the pointer is, how big the brush is, how
// hard it is pressed and for how long, so the same stroke twice is the same
// ground (Invariant 2).
//
// Strength is metres per second at the brush's centre (PLAN-editors.md §2.2):
// a dab is strength × dt × falloff(d), so holding the pointer still keeps
// raising and a stroke feels the same at every frame rate. The falloff is a
// curve from the brush's core (full strength) to its edge; the shape is a
// circle or a square. Within a few metres of the land's boundary the strength
// fades to nothing, so a neighbour never gets a cliff (the operator's
// `edge_blend` setting, never the player's).
//
// `ground(lon, lat)` is what the DEM says is there, in metres. The brushes
// that aim at a height — flatten, level, along line — need it, because the
// grid holds the difference and the player is looking at the sum.

export const CURVES = ['smooth', 'linear', 'sharp', 'plateau'];
export const SHAPES = ['circle', 'square'];
// How wide the band inside the boundary is where the brush fades out.
export const BAND_M = 4;

/**
 * How strong the brush is at `t` of its radius (0 centre, 1 edge). `soft` is
 * the share of the radius the fall takes: 0 is a hard edge, 1 falls from the
 * very centre.
 */
export function falloffAt(t, { soft = 0.6, curve = 'smooth' } = {}) {
    if (t >= 1) return 0;
    const core = 1 - Math.min(1, Math.max(0, soft));
    if (t <= core) return 1;
    const u = (t - core) / Math.max(1e-6, 1 - core);
    if (curve === 'linear') return 1 - u;
    if (curve === 'sharp') return (1 - u) ** 3;
    if (curve === 'plateau') return 1 - u ** 4;
    return 1 - u * u * (3 - 2 * u);
}

// How far a brush cell is from the middle, as a share of the radius: round,
// or square (the larger of the two offsets).
const reach = (dx, dz, radius, shape) => (shape === 'square'
    ? Math.max(Math.abs(dx), Math.abs(dz)) : Math.hypot(dx, dz)) / Math.max(0.001, radius);

/**
 * The fade at the land's edge: 1 more than `band` metres inside, falling to 0
 * at the boundary. `rings` are the land's rings in degrees.
 */
export function bandAt(rings, lon, lat, band = BAND_M) {
    const mLon = 111320 * Math.cos(lat * Math.PI / 180);
    let near = Infinity;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const ax = (ring[j][0] - lon) * mLon;
            const az = (ring[j][1] - lat) * 110540;
            const bx = (ring[i][0] - lon) * mLon;
            const bz = (ring[i][1] - lat) * 110540;
            const dx = bx - ax;
            const dz = bz - az;
            const t = Math.max(0, Math.min(1, -(ax * dx + az * dz) / (dx * dx + dz * dz || 1)));
            near = Math.min(near, Math.hypot(ax + dx * t, az + dz * t));
        }
    }
    return Math.min(1, near / band);
}

/**
 * One dab. `how` is {brush, size (m), strength (m/s), dt (s), soft, curve,
 * shape, invert (Shift), target, ground, blend (edge blend on)}.
 *
 * Returns how many cells moved — none outside the land, which is what the red
 * brush on the clay is about.
 */
export function dab(shaping, lon, lat, how) {
    if (!shaping.inside(lon, lat)) return 0;
    const radius = how.size / 2;
    const square = how.shape === 'square';
    const cells = shaping.near(lon, lat, square ? radius * Math.SQRT2 : radius);
    const mLon = 111320 * Math.cos(lat * Math.PI / 180);
    const step = Math.max(0, how.strength ?? 0.5) * Math.max(0, how.dt ?? 1 / 60);
    const moved = [];
    for (const c of cells) {
        const at = { lon: shaping.lonOf(c.i), lat: shaping.latOf(c.j) };
        const t = reach((at.lon - lon) * mLon, (at.lat - lat) * 110540, radius, how.shape);
        const k = falloffAt(t, how)
            * (how.blend === false ? 1 : bandAt(shaping.rings, at.lon, at.lat));
        if (k <= 0 || !shaping.inside(at.lon, at.lat)) continue;
        const was = shaping.grid.data[c.k];
        const now = value(shaping, c, at, { ...how, k, was, lon, lat, step });
        if (now === was || !Number.isFinite(now)) continue;
        shaping.remember(c.k);
        shaping.grid.data[c.k] = now;
        moved.push(c.k);
    }
    if (moved.length) shaping.mark(moved);
    return moved.length;
}

// Towards `to` by no more than `most`.
const toward = (from, to, most) => from + Math.max(-most, Math.min(most, to - from));

function value(shaping, c, at, how) {
    const { brush, step, k, was } = how;
    if (brush === 'raise' || brush === 'lower') {
        const sign = (brush === 'lower') !== Boolean(how.invert) ? -1 : 1;
        return was + sign * step * k;
    }
    if (brush === 'smooth') return toward(was, around(shaping, c), step * k);
    if (brush === 'putback') return toward(was, 0, step * k);
    // Flatten and level both aim at an absolute height and store the
    // difference: what the player sees is the DEM plus what is written here.
    const want = brush === 'level' ? Number(how.target)
        : how.target ?? (how.ground?.(how.lon, how.lat) ?? 0) + shaping.at(how.lon, how.lat);
    if (!Number.isFinite(want)) return was;
    const wanted = want - (how.ground?.(at.lon, at.lat) ?? 0);
    // A bed is laid in one pass, its shoulder blending into what was there.
    if (brush === 'bed') return was + (wanted - was) * k;
    return toward(was, wanted, step * k);
}

// The mean of the eight cells around one, which is what smoothing is.
function around(shaping, c) {
    const { width, height, data } = shaping.grid;
    let sum = 0;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
            const i = c.i + di;
            const j = c.j + dj;
            if (i < 0 || j < 0 || i >= width || j >= height) continue;
            sum += data[j * width + i];
            n += 1;
        }
    }
    return n ? sum / n : data[c.k];
}

// ------------------------------------------------------------- along a line

// A road bed: the ground under the line is pulled to the line's own height,
// smoothed and held to a gradient, and the shoulder fades back to whatever was
// there. Written once, as one stroke, so one undo takes the whole bed back.
export function alongLine(shaping, points, how) {
    const { width = 7, shoulder = 1, gradient = 8, ground = () => 0 } = how ?? {};
    const path = walk(points, Math.max(0.5, shaping.grid.cell));
    if (path.length < 2) return { moved: 0, steepest: 0, metres: 0 };
    const levels = held(path, ground, gradient / 100);
    shaping.begin();
    let moved = 0;
    for (let i = 0; i < path.length; i++) {
        // A bed is laid, not painted: all the way to its height at once.
        moved += dab(shaping, path[i].lon, path[i].lat, {
            brush: 'bed', size: width + shoulder * 2, strength: 1, dt: 1,
            soft: shoulder * 2 / (width + shoulder * 2), curve: 'smooth',
            target: levels[i], ground, blend: false,
        });
    }
    shaping.end();
    return { moved, metres: path.at(-1).at,
        steepest: Math.max(...levels.slice(1).map((h, i) =>
            Math.abs(h - levels[i]) / Math.max(0.001, path[i + 1].at - path[i].at))) * 100 };
}

// The line, resampled every `step` metres, with how far along each point is.
function walk(points, step) {
    const out = [];
    let at = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const mPerLon = 111320 * Math.cos(a.lat * Math.PI / 180);
        const len = Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * 110540);
        for (let d = 0; d < len; d += step) {
            out.push({ lon: a.lon + (b.lon - a.lon) * (d / len),
                lat: a.lat + (b.lat - a.lat) * (d / len), at: at + d });
        }
        at += len;
    }
    const last = points.at(-1);
    out.push({ lon: last.lon, lat: last.lat, at });
    return out;
}

// The height the bed sits at: the ground along the line, smoothed, then held
// to the gradient the player asked for, forwards and back.
function held(path, ground, limit) {
    let h = path.map((p) => ground(p.lon, p.lat));
    for (let pass = 0; pass < 8; pass++) {
        h = h.map((v, i) => (v + h[Math.max(0, i - 1)] + h[Math.min(h.length - 1, i + 1)]) / 3);
    }
    for (let i = 1; i < h.length; i++) {
        const run = Math.max(0.001, path[i].at - path[i - 1].at);
        h[i] = clampStep(h[i - 1], h[i], run * limit);
    }
    for (let i = h.length - 2; i >= 0; i--) {
        const run = Math.max(0.001, path[i + 1].at - path[i].at);
        h[i] = clampStep(h[i + 1], h[i], run * limit);
    }
    return h;
}

const clampStep = (from, to, most) =>
    Math.min(from + most, Math.max(from - most, to));
