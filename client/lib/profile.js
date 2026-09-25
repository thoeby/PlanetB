// profile.js — a line's height along its length, and its slope (EDT.5,
// reused by EDT.16's profile strip for a drawn line).
//
// Pure: `heightAt(lon, lat)` is whatever ground the caller has — Blueprint's
// shaped clay in the page, a function in the tests.

const M_LAT = 110540;
const mLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

// Metres between two points given in degrees.
export const metresBetween = (a, b) =>
    Math.hypot((b.lon - a.lon) * mLon((a.lat + b.lat) / 2), (b.lat - a.lat) * M_LAT);

/**
 * The line resampled every `step` metres, each sample with how far along it
 * is (`at`) and the ground's height there (`h`, null off the ground). The
 * corners are always among the samples.
 */
export function sampleAlong(points, heightAt, step = 1) {
    const out = [];
    let at = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const len = metresBetween(a, b);
        const n = Math.max(1, Math.ceil(len / step - 1e-6));
        for (let k = 0; k < n; k++) {
            const t = k / n;
            const lon = a.lon + (b.lon - a.lon) * t;
            const lat = a.lat + (b.lat - a.lat) * t;
            out.push({ lon, lat, at: at + len * t, h: heightAt(lon, lat) });
        }
        at += len;
    }
    const last = points.at(-1);
    if (last) out.push({ lon: last.lon, lat: last.lat, at, h: heightAt(last.lon, last.lat) });
    return out;
}

// The slope of each step, in percent: rise over run, signed uphill positive.
export function slopes(samples) {
    const out = [];
    for (let i = 1; i < samples.length; i++) {
        const run = samples[i].at - samples[i - 1].at;
        const a = samples[i - 1].h;
        const b = samples[i].h;
        out.push(run > 0 && a !== null && b !== null ? (b - a) / run * 100 : 0);
    }
    return out;
}

/**
 * Where the line is steeper than `maxPct` either way: runs of steps as
 * {from, to, steepest} in metres along, the steepest in percent. Slope is
 * averaged over `over` metres first, so one cell's noise is not a hill.
 */
export function overGradient(samples, maxPct, over = 5) {
    const s = slopes(samples);
    const out = [];
    let run = null;
    for (let i = 0; i < s.length; i++) {
        const j = firstFrom(samples, i, over);
        const rise = (samples[j].h ?? 0) - (samples[i].h ?? 0);
        const len = samples[j].at - samples[i].at;
        const pct = len > 0 ? Math.abs(rise / len * 100) : Math.abs(s[i]);
        if (pct > maxPct) {
            run = run ?? { from: samples[i].at, to: samples[i + 1].at, steepest: 0 };
            run.to = samples[i + 1].at;
            run.steepest = Math.max(run.steepest, pct);
        } else if (run) {
            out.push(run);
            run = null;
        }
    }
    if (run) out.push(run);
    return out;
}

function firstFrom(samples, i, over) {
    let j = i + 1;
    while (j < samples.length - 1 && samples[j].at - samples[i].at < over) j += 1;
    return j;
}

// The sample nearest a point, and how far off the line the point is, metres.
export function nearestSample(samples, lon, lat) {
    let best = null;
    for (const s of samples) {
        const d = metresBetween(s, { lon, lat });
        if (!best || d < best.d) best = { d, sample: s };
    }
    return best;
}

// The sample at a distance along, by the nearest one.
export function sampleAt(samples, at) {
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.at - at) < Math.abs(best.at - at)) best = s;
    return best;
}
