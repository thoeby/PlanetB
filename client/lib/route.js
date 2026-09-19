// route.js — where a thing that moves by the clock is, at a given second.
//
// TASKS-foundation.md FND.16. A mover is a line, a speed and a timetable
// (db/0171); nothing about it is stored per frame and nothing is written as it
// moves. Two players standing at the same stop see the same bus at the same
// second because both work it out from the same three things and the same
// clock (`world_clock`, db/0168).
//
// Pure: no DOM, no clock of its own, no state. The tests give it a line and a
// timetable and ask where it is (client/test/route.test.js).

const M_PER_DEG = 111320;

// The metres between two points on the ground, near enough for a bus route:
// the world is flat over a few kilometres and the tiles are drawn that way
// everywhere else in this code too.
export function metresBetween(a, b) {
    const lat = (a[1] + b[1]) / 2;
    const east = (b[0] - a[0]) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
    const north = (b[1] - a[1]) * M_PER_DEG;
    return Math.hypot(east, north);
}

// The line, with how far along each of its corners is. Done once per route.
export function alongOf(route) {
    const at = [0];
    for (let i = 1; i < (route?.length ?? 0); i++) {
        at.push(at[i - 1] + metresBetween(route[i - 1], route[i]));
    }
    return at;
}

export const lengthOf = (route) => alongOf(route).at(-1) ?? 0;

// The point so many metres along the line, and which way it is facing there.
export function atMetres(route, along, metres) {
    if (!route?.length) return null;
    const total = along.at(-1);
    const want = Math.max(0, Math.min(total, metres));
    let i = 1;
    while (i < along.length - 1 && along[i] < want) i += 1;
    const span = along[i] - along[i - 1];
    const k = span > 0 ? (want - along[i - 1]) / span : 0;
    const [x0, y0] = route[i - 1];
    const [x1, y1] = route[i];
    const lat = y0 + (y1 - y0) * k;
    const east = (x1 - x0) * Math.cos(lat * Math.PI / 180);
    return { lon: x0 + (x1 - x0) * k, lat,
        // Degrees clockwise from north, which is how a heading is written.
        heading: (Math.atan2(east, y1 - y0) * 180 / Math.PI + 360) % 360 };
}

// The stops, in the order they are passed, each as far along as it is.
const stopsOf = (schedule, total) => (schedule?.dwell ?? [])
    .map((d) => ({ at: Math.max(0, Math.min(total, Number(d.at_m) || 0)),
        hold: Math.max(0, Number(d.s) || 0) }))
    .sort((a, b) => a.at - b.at);

// How long one run takes: the driving, plus every stop it makes.
export function runSeconds(route, schedule, speedKmh) {
    const total = lengthOf(route);
    const speed = Math.max(0.1, (Number(speedKmh) || 0) / 3.6);
    const held = stopsOf(schedule, total).reduce((s, d) => s + d.hold, 0);
    return { total, speed, driving: total / speed, run: total / speed + held };
}

// How far along a run is after `t` seconds of it: the driving and the standing
// still, in the order they happen. Past the end of the run it is at the end.
export function alongAfter(t, { total, speed }, stops) {
    let left = Math.max(0, t);
    let done = 0;
    for (const stop of stops) {
        const leg = (stop.at - done) / speed;
        if (left < leg) return done + left * speed;
        left -= leg;
        done = stop.at;
        if (left < stop.hold) return done;
        left -= stop.hold;
    }
    return Math.min(total, done + left * speed);
}

// Where a mover is at world-time `t`, in seconds.
//
// One cycle is the timetable's `every_s`: the run happens inside it and, if
// the run is shorter, the mover waits at the end of it for the next one. A
// "circle" route starts again at the beginning; a "back_and_forth" one comes
// back the way it came, in the same cycle.
export function positionAt(route, schedule, speedKmh, t, phase = 0) {
    if (!route || route.length < 2) return null;
    const along = alongOf(route);
    const { total, speed, run } = runSeconds(route, schedule, speedKmh);
    const stops = stopsOf(schedule, total);
    const back = (schedule?.loop ?? 'circle') === 'back_and_forth';
    const every = Math.max(1, Number(schedule?.every_s) || 600);
    const cycle = Math.max(every, back ? run * 2 : run);
    const into = (((Number(t) || 0) + (Number(phase) || 0)) % cycle + cycle) % cycle;
    if (!back) {
        const where = atMetres(route, along, alongAfter(into, { total, speed }, stops));
        return { ...where, along: alongAfter(into, { total, speed }, stops) };
    }
    const home = into >= run;
    const metres = home
        ? total - alongAfter(into - run, { total, speed }, stops)
        : alongAfter(into, { total, speed }, stops);
    const where = atMetres(route, along, metres);
    return { ...where, along: metres,
        heading: (where.heading + (home ? 180 : 0)) % 360 };
}
