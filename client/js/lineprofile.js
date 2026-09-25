// lineprofile.js — the selected line's profile (EDT.16, PLAN-editors.md idea
// 21): its height along its length, the stretches steeper than its kind
// allows, and the places the ground falls too fast across it — the same
// measurement the compiler and Submit make (client/lib/gen/check.js).

import { nearestSample, overGradient, sampleAlong } from '../lib/profile.js';
import { flagsAlong } from '../lib/gen/check.js';
import { frameAt } from '../lib/spline.js';
import { curveOf } from './lines.js';

// How steep across a road may be before it is flagged, per cent (FND.11).
export const ACROSS_PCT = 8;

/**
 * {samples, marks, max, over}: `marks` where it is too steep across, `over`
 * the stretches steeper along than `entry.gradient`.
 */
export function profileOf(line, entry, heightAt) {
    const pts = curveOf(line);
    const samples = sampleAlong(pts, heightAt, 1);
    const f = frameAt(pts[0].lon, pts[0].lat);
    const xz = pts.map((p) => f.toXZ(p.lon, p.lat));
    const flags = flagsAlong([xz], { width: Number(line.props?.width) || entry?.width || 5,
        max_cross_slope: ACROSS_PCT, every: 5 }, (x, z) => {
        const g = f.toLonLat([x, z]);
        return heightAt(g.lon, g.lat) ?? 0;
    });
    const marks = flags.map((fl) => {
        const g = f.toLonLat([fl.x, fl.z]);
        return { at: nearestSample(samples, g.lon, g.lat).sample.at, slope: fl.slope };
    });
    const max = entry?.gradient ?? null;
    return { samples, marks, max, over: max ? overGradient(samples, max) : [] };
}
