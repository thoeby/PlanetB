// scatter.js — models spread over an area, on a Poisson disc.
//
// Until a collection is named the models are the proxy trees `assemble` has
// scattered since WP2 — a trunk and three tiers of cone, each its own height
// and its own shade of the stand's colour, because a forest of one tree
// repeated is what a forest never looks like.
//
// Parameters: `collection` (a product, FND.5), `spacing` (m between models),
// `height` ([low, high]), `sides`, `taper`, `colour`, `mature`, `age_prop`,
// `max_slope` (refused above it), and the exclusions earlier features left.
//
// Deterministic (Invariant 2): the draws come from the atom's own seed, in
// the order the features arrive in.

import { scatterOne } from '../props.js';

export function run(params, feature, ctx) {
    const radius = Number.isFinite(Number(params.spacing))
        ? Number(params.spacing) : ctx.radius;
    const style = { height: params.height, height_min: params.height_min,
        height_max: params.height_max, sides: params.sides, taper: params.taper,
        color: params.colour, mature: params.mature, age_prop: params.age_prop };
    ctx.trees += scatterOne(feature, ctx.terrain, ctx.random, radius, style,
        ctx.mesh('trunk'), ctx.mesh('canopy'));
    return null;
}
