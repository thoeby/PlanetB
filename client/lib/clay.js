// clay.js — what the ground looks like in Blueprint: white clay lit from the
// north-west, going grey and then warm as it steepens, and the overlays a
// person shaping it switches on (PLAN-editors.md §1, ideas 1–3).
//
// Pure arithmetic, so the mapping is node-tested (client/test/clay.test.js)
// and the page only copies the numbers into vertex colours.

// Where the light comes from, in the scene's frame (x east, y up, z south):
// high in the north-west, the way a relief map is lit.
export const SUN = (() => {
    const v = [-0.5, 0.75, -0.45];
    const n = Math.hypot(...v);
    return v.map((q) => q / n);
})();

const WHITE = [0.95, 0.94, 0.91];
const GREY = [0.7, 0.7, 0.7];
const WARM = [0.86, 0.6, 0.42];
const RAISED = [0.25, 0.47, 0.92];
const LOWERED = [0.88, 0.3, 0.24];
const STEEP = [0.97, 0.68, 0.2];

// The slope where clay stops being white, and where it is fully warm.
export const GREY_AT = 20;
export const WARM_AT = 35;

// How dark everybody else's ground is drawn: 60 % darker than yours.
export const DIM = 0.4;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t];
const clamp01 = (t) => Math.min(1, Math.max(0, t));

// The colour of the clay at a slope, before it is lit.
export function clayAt(slopeDeg) {
    if (slopeDeg <= GREY_AT) return mix(WHITE, GREY, clamp01(slopeDeg / GREY_AT) ** 2);
    return mix(GREY, WARM, clamp01((slopeDeg - GREY_AT) / (WARM_AT - GREY_AT)));
}

// How much light a surface with this normal catches: never black, because the
// side facing away from the sun is still clay you have to read.
export const litBy = (nx, ny, nz) =>
    0.5 + 0.5 * Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);

// A normal and a slope from the four neighbours' heights, in metres, with the
// grid spacing east (`dx`) and south (`dz`).
export function normalOf(l, r, u, d, dx, dz) {
    const v = [-(r - l) / (2 * dx), 1, -(d - u) / (2 * dz)];
    const len = Math.hypot(v[0], v[1], v[2]);
    const slope = Math.atan(Math.hypot(v[0], v[2])) * 180 / Math.PI;
    return { nx: v[0] / len, ny: v[1] / len, nz: v[2] / len, slope };
}

// What you changed, as colour: blue above the elevation, red below, stronger
// the further off it is, and nothing at all where nothing was moved.
export function changedTint(delta) {
    const a = Math.abs(delta);
    if (a < 0.01) return null;
    return { colour: delta > 0 ? RAISED : LOWERED, alpha: 0.2 + 0.55 * clamp01(a / 3) };
}

// Unsaved shaping is hatched: diagonal bands of the grid, so saved and unsaved
// are different at a glance without a second colour to learn.
export const hatched = (i, j, every = 6) => ((i + j) % every) < every / 2;

// The colours here are as they are seen (sRGB); the engine takes vertex
// colours as linear light and brightens them on the way out, so they go to it
// through this. Without it everybody else's ground, dimmed to 40 %, came out
// at two thirds of white.
export const linear = (c) => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

/**
 * One vertex's colour. `how` is {slope, lit, inside, delta, unsaved, i, j,
 * changed, steep} — the last two the overlay switches, `steep` the slope in
 * degrees above which the ground is marked (or 0 for off).
 */
export function vertexColour(how) {
    let c = clayAt(how.slope).map((q) => q * how.lit);
    if (how.steep && how.slope > how.steep) c = mix(c, STEEP, 0.55);
    if (how.changed) {
        const t = changedTint(how.delta);
        if (t) c = mix(c, t.colour, t.alpha);
        if (how.unsaved && hatched(how.i, how.j)) {
            c = mix(c, how.delta >= 0 ? RAISED : LOWERED, 0.35);
        }
    }
    if (!how.inside) c = c.map((q) => q * DIM);
    return c;
}
