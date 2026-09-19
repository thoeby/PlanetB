// check.js — a layer that builds nothing and says something.
//
// A road laid across a hillside without shaping the ground first is a road
// that cannot be driven. Every few metres the ground is measured across the
// line; anywhere it falls faster than the symbol allows is flagged. It is a
// warning, not a refusal (FND.11): the flags travel with the atom's result
// and the Submit dialog says them before anything is sent.
//
// Parameters: `width` (m to measure across), `max_cross_slope` (per cent),
// `every` (m between samples).

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function run(params, feature, ctx) {
    return { flags: flagsAlong(feature.lines ?? [], params,
        (x, z) => ctx.terrain.at(x, z)) };
}

/**
 * The same measurement the page makes on Submit, over lines in metres.
 *
 * FND.11: a road laid across a hillside without shaping the ground first is a
 * road nobody can drive. It is a warning and never a refusal — the submission
 * goes through and says this.
 *
 * @param {Array<Array<[number, number]>>} lines
 * @param {{width?: number, max_cross_slope?: number, every?: number}} params
 * @param {(x: number, z: number) => number} heightAt
 */
export function flagsAlong(lines, params, heightAt) {
    const width = num(params?.width, 5);
    const limit = num(params?.max_cross_slope, 8) / 100;
    const every = Math.max(1, num(params?.every, 5));
    const flags = [];
    for (const line of lines ?? []) {
        for (let i = 0; i + 1 < line.length; i++) {
            flags.push(...alongSegment(line[i], line[i + 1], width, limit, every,
                { terrain: { at: heightAt } }));
        }
    }
    return flags;
}

function alongSegment(a, b, width, limit, every, ctx) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len <= 0) return [];
    const nx = -dz / len * (width / 2);
    const nz = dx / len * (width / 2);
    const out = [];
    for (let at = 0; at < len; at += every) {
        const x = a[0] + dx * (at / len);
        const z = a[1] + dz * (at / len);
        const left = ctx.terrain.at(x + nx, z + nz);
        const right = ctx.terrain.at(x - nx, z - nz);
        const slope = Math.abs(left - right) / Math.max(0.01, width);
        if (slope > limit) out.push({ x, z, slope: Math.round(slope * 1000) / 1000 });
    }
    return out;
}
