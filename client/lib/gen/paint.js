// paint.js — a material over the ground, rather than a thing standing on it.
//
// It draws nothing: what it leaves behind is a request the ground cover reads
// (FND.12) — this material, over these rings, blended this far. Until then it
// is recorded and the terrain keeps the colour it has.
//
// Parameters: `material` (a product), `blend` (m of soft border), `noise`.

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function run(params, feature, ctx) {
    if (!params.material) return null;
    ctx.paints.push({
        material: params.material,
        rings: feature.rings ?? [],
        lines: feature.lines ?? [],
        width: num(params.width, 0),
        blend: num(params.blend, 1),
        noise: num(params.noise, 0),
    });
    return { exclusions: [] };
}
