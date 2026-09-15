// light.js — the one sky this world is lit by.
//
// Three places have to agree about it or the world comes apart at the seams:
// the ground mesh a player walks on (client/lib/groundtile.js), the splats a
// tile is sampled into (client/atoms/assemble.js), and the pictures the trainer
// is shown (client/lib/raster.js, which draws what assemble baked). They
// agreed before on one number — `0.55 + 0.55 * max(dot(n, sun), 0)` — which
// is a lamp in a white room: every surface facing away from the sun was the
// same flat grey, and every surface facing it was the same flat bright, and a
// hillside came out as a single colour with no shape in it.
//
// So: a sun with a colour, a sky that is blue and comes from above, and the
// ground bouncing a little warmth back up. Plus a curve at the end, because
// the albedos here are a third of white and a third of white is mud.
//
// It is not physically based and does not pretend to be. It is fixed, it is
// deterministic, and two tabs computing the same tile compute the same
// numbers (Invariant 2) — which is all a compile asks of it.

const norm = (v) => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
};

export const SUN = norm([0.42, 0.83, 0.36]);
// Warm, and not quite white: the difference between a sunlit face and a shaded
// one has to be a difference in colour as well as in brightness, or the eye
// reads it as the same surface at two exposures.
export const SUN_COLOUR = [1.12, 1.02, 0.86];
export const SUN_STRENGTH = 0.72;
// What a surface sees of the sky, straight up; and what it sees of the ground,
// straight down. The second one is why an overhang is not black.
export const SKY_COLOUR = [0.44, 0.52, 0.68];
export const BOUNCE_COLOUR = [0.30, 0.28, 0.23];

// The light arriving at a surface, as a multiplier on its own colour.
// `openness` is how much of the sky it can see — 1 in the open, less in a
// hollow — and is what gives a hillside its creases. `sunlit` is whether the
// sun reaches it at all — 0 behind a ridge (terrain.js sunlitAt) — and is
// what gives a valley its afternoon.
export function lightAt(n, openness = 1, sunlit = 1) {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const up = n[1] / len;
    const d = Math.max((n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]) / len, 0) * sunlit;
    const sky = (up * 0.5 + 0.5) * openness;
    const out = [];
    for (let i = 0; i < 3; i++) {
        out.push(SUN_COLOUR[i] * d * SUN_STRENGTH * (0.35 + 0.65 * openness)
            + SKY_COLOUR[i] * sky
            + BOUNCE_COLOUR[i] * (1 - sky));
    }
    return out;
}

// The curve at the end. Everything in this world is authored at about a third
// of white — grass, rock, roof tiles — and a third of white lit by a sun is
// still a third of white. This lifts the middle without touching the top, so
// the picture reads as daylight rather than as dusk. There is no second gamma
// hiding here: nothing that reaches this has been display-encoded, because
// nothing in this world is photographed.
export const TONE = 1.4;
export const tone = (c) => Math.min((Math.max(c, 0)) ** (1 / TONE), 1);

// A surface's own colour, lit and toned: what a splat carries, what a vertex
// of the ground mesh is given, and — since assemble-v3 bakes it into the
// scene — what the frame atom draws. One number, computed once, seen the same
// from every side: that is why a sampled tile, a trained one and the ground
// between them meet without a seam.
export function shade(colour, n, openness = 1, sunlit = 1) {
    const light = lightAt(n, openness, sunlit);
    return [tone(colour[0] * light[0]), tone(colour[1] * light[1]),
        tone(colour[2] * light[2])];
}

// The same thing again in GLSL, for the frame atom's shader
// (client/lib/render.js). Written out here rather than there so the two live
// next to each other and are changed together.
export const GLSL = `
const vec3 SUN = vec3(${SUN.map((v) => v.toFixed(6)).join(', ')});
const vec3 SUN_COLOUR = vec3(${SUN_COLOUR.join(', ')});
const vec3 SKY_COLOUR = vec3(${SKY_COLOUR.join(', ')});
const vec3 BOUNCE_COLOUR = vec3(${BOUNCE_COLOUR.join(', ')});
vec3 lightAt(vec3 n, float openness) {
    float d = max(dot(n, SUN), 0.0);
    float sky = (n.y * 0.5 + 0.5) * openness;
    return SUN_COLOUR * d * ${SUN_STRENGTH} * (0.35 + 0.65 * openness)
        + SKY_COLOUR * sky + BOUNCE_COLOUR * (1.0 - sky);
}
vec3 toned(vec3 c) {
    return min(pow(max(c, vec3(0.0)), vec3(1.0 / ${TONE})), vec3(1.0));
}`;
