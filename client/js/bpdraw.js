// bpdraw.js — lines drawn over the Blueprint clay every frame: a path lying
// on the ground, a cross where something is marked, a ring. Immediate lines
// (PlayCanvas drawLine), so nothing is kept and nothing has to be cleaned up.

// How far off the clay a drawn line stands, so it is not buried in it.
const LIFT_M = 0.3;

export function onGround(bp, lon, lat, lift = LIFT_M) {
    const h = bp.heightAt(lon, lat);
    if (h === null || !bp.active) return null;
    return bp.toScene(lon, lat, h + lift);
}

// A path along the ground, resampled so it follows a hill between corners.
export function drawPath(bp, app, pc, points, colour, { step = 4, lift = LIFT_M } = {}) {
    let was = null;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const n = b ? Math.max(1, Math.ceil(metres(a, b) / step)) : 1;
        for (let k = 0; k < n; k++) {
            const t = b ? k / n : 0;
            const p = onGround(bp, a.lon + ((b?.lon ?? a.lon) - a.lon) * t,
                a.lat + ((b?.lat ?? a.lat) - a.lat) * t, lift);
            if (p && was) app.drawLine(was, p, colour);
            was = p ?? was;
        }
    }
}

// A cross on the ground and a stalk off it.
export function drawMark(bp, app, pc, at, colour, arm = 2) {
    const mid = onGround(bp, at.lon, at.lat);
    if (!mid) return;
    const dLon = arm / (111320 * Math.cos(at.lat * Math.PI / 180));
    const dLat = arm / 110540;
    for (const [dx, dy] of [[dLon, 0], [-dLon, 0], [0, dLat], [0, -dLat]]) {
        const end = onGround(bp, at.lon + dx, at.lat + dy);
        if (end) app.drawLine(mid, end, colour);
    }
    app.drawLine(mid, new pc.Vec3(mid.x, mid.y + arm, mid.z), colour);
}

// A ring of `radius` metres, or a square of that half-width.
export function drawRing(bp, app, at, radius, colour, square = false) {
    const around = 64;
    const mLon = 111320 * Math.cos(at.lat * Math.PI / 180);
    let was = null;
    for (let i = 0; i <= around; i++) {
        const a = (i / around) * Math.PI * 2;
        let [dx, dz] = [Math.cos(a), Math.sin(a)];
        if (square) {
            const k = 1 / Math.max(Math.abs(dx), Math.abs(dz));
            dx *= k;
            dz *= k;
        }
        const p = onGround(bp, at.lon + dx * radius / mLon, at.lat + dz * radius / 110540);
        if (p && was) app.drawLine(was, p, colour);
        was = p;
    }
}

const metres = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180),
    (b.lat - a.lat) * 110540);
