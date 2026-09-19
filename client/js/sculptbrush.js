// sculptbrush.js — what each brush does to the grid.
//
// FND.9. Every one of them writes relative metres into `Shaping`'s grid and
// nothing else: a stroke is a function of where the pointer is, how big the
// brush is and how hard it is pressed, so the same stroke twice is the same
// ground (Invariant 2).
//
// `ground(lon, lat)` is what the DEM says is there, in metres. The brushes
// that aim at a height — flatten, level, along line — need it, because the
// grid holds the difference and the player is looking at the sum.

const falloff = (d, radius) => {
    const t = Math.min(1, Math.max(0, d / Math.max(0.001, radius)));
    return (1 - t * t) ** 2;
};

/**
 * One dab. `how` is {brush, size (m), strength (m per dab), target, ground}.
 *
 * Returns how many cells moved — none outside the land, which is what the red
 * brush in the panel is about.
 */
export function dab(shaping, lon, lat, how) {
    if (!shaping.inside(lon, lat)) return 0;
    const cells = shaping.near(lon, lat, how.size / 2);
    let moved = 0;
    for (const c of cells) {
        const at = { lon: shaping.lonOf(c.i), lat: shaping.latOf(c.j) };
        if (!shaping.inside(at.lon, at.lat)) continue;
        const k = falloff(c.d, how.size / 2);
        const was = shaping.grid.data[c.k];
        const now = value(shaping, c, at, { ...how, k, was, lon, lat });
        if (now === was) continue;
        shaping.remember(c.k);
        shaping.grid.data[c.k] = now;
        moved += 1;
    }
    if (moved) shaping.mark(shaping.stroke ?? new Map());
    return moved;
}

function value(shaping, c, at, how) {
    const { brush, strength, k, was } = how;
    if (brush === 'raise') return was + strength * k;
    if (brush === 'lower') return was - strength * k;
    if (brush === 'smooth') return was + (around(shaping, c) - was) * k * 0.6;
    // Flatten and level both aim at an absolute height and store the
    // difference: what the player sees is the DEM plus what is written here.
    const want = brush === 'level' ? Number(how.target)
        : how.target ?? (how.ground?.(how.lon, how.lat) ?? 0) + shaping.at(how.lon, how.lat);
    if (!Number.isFinite(want)) return was;
    const wanted = want - (how.ground?.(at.lon, at.lat) ?? 0);
    return was + (wanted - was) * k;
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
        moved += dab(shaping, path[i].lon, path[i].lat, {
            brush: 'flatten', size: width + shoulder * 2, strength: 1,
            target: levels[i], ground,
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
