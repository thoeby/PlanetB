// joint.js — where a moving part is at a second of the world clock.
//
// TASKS-live.md LV.1. A joint is told a `pose`, a `path` or a `spin`, and the
// world records the clock of the write and where the part was then (db/0200).
// Every tab evaluates the same motion from the same row against the same
// clock, so the arm is in the same place in every tab at the same second.
// These are db/0200's pose_at, spin_at and path_at, line for line; the pgTAP
// test and client/test/joint.test.js check the same numbers.
//
// Pure: no clock, no network, no engine.

export const KEYS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'scale'];
export const REST = Object.freeze({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 });
export const MOTIONS = ['pose', 'path', 'spin'];

const num = (v, fallback) => {
    const n = Number(v);
    return v === null || v === undefined || !Number.isFinite(n) ? fallback : n;
};

const of = (p, k) => num(p?.[k], REST[k]);

export function poseAt(value, start, clock, t) {
    const over = num(value?.over_s, 0);
    const f = over <= 0 ? 1 : Math.min(1, Math.max(0, (t - clock) / over));
    const out = {};
    for (const k of KEYS) {
        const from = of(start, k);
        out[k] = from + (num(value?.to?.[k], from) - from) * f;
    }
    return out;
}

const AXIS = { x: 'pitch', y: 'yaw', z: 'roll' };

// SQL's mod() keeps the sign of the dividend, and so does `%`.
export function spinAt(value, start, clock, t) {
    const k = AXIS[value?.axis ?? 'y'] ?? 'yaw';
    const out = { ...REST, ...(start ?? {}) };
    out[k] = (of(start, k) + num(value?.rpm, 0) * 6 * (t - clock)) % 360;
    return out;
}

const leg = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export function pathAt(value, clock, t) {
    const pts = value?.route_m ?? [];
    if (pts.length < 2) return { ...REST };
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) total += leg(pts[i], pts[i + 1]);
    let d = Math.max(0, num(value.speed, 0) * (t - clock));
    if (total <= 0) d = 0;
    else if (value.loop) d -= total * Math.floor(d / total);
    else d = Math.min(d, total);
    for (let i = 0; i < pts.length - 1; i++) {
        const seg = leg(pts[i], pts[i + 1]);
        if (d <= seg || i === pts.length - 2) {
            const [a, b] = [pts[i], pts[i + 1]];
            const f = seg > 0 ? Math.min(1, d / seg) : 0;
            return { ...REST, x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f,
                z: a[2] + (b[2] - a[2]) * f,
                yaw: Math.atan2(-(b[0] - a[0]), -(b[2] - a[2])) * 180 / Math.PI };
        }
        d -= seg;
    }
    return { ...REST };
}

export function motionAt(type, value, start, clock, t) {
    if (type === 'pose') return poseAt(value, start, clock, t);
    if (type === 'spin') return spinAt(value, start, clock, t);
    if (type === 'path') return pathAt(value, clock, t);
    return { ...REST };
}

// When a motion is done: the second a pose arrives, never for a path that
// loops or a spin. What story 40 compares between two tabs.
export function arrivesAt(type, value, clock) {
    if (type === 'pose') return clock + Math.max(0, num(value?.over_s, 0));
    if (type === 'path' && !value?.loop) {
        const pts = value?.route_m ?? [];
        let total = 0;
        for (let i = 0; i < pts.length - 1; i++) total += leg(pts[i], pts[i + 1]);
        return clock + total / Math.max(1e-9, num(value?.speed, 1));
    }
    return Infinity;
}

// The part's pose at `t`, from the rows of every motion port that drives it:
// the latest one told wins, as db/0200 part_now has it.
export function jointAt(rows, t) {
    let best = null;
    for (const r of rows ?? []) {
        if (!MOTIONS.includes(r.type) || !Number.isFinite(Number(r.clock))) continue;
        if (!best || Number(r.clock) > Number(best.clock)
            || (Number(r.clock) === Number(best.clock) && (r.rev ?? 0) > (best.rev ?? 0))) {
            best = r;
        }
    }
    return best ? motionAt(best.type, best.value, best.start, Number(best.clock), t)
        : { ...REST };
}
