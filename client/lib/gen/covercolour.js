// covercolour.js — what the ground cover looks like, and how thickly it is
// scattered.
//
// Split out of client/lib/gen/cover.js, which is the reading: the classes of a
// tile and how much of each is at a point. This is what is done with that
// number — the material a class is made of, sampled at its own size over the
// ground, and the share of the draws a class keeps where it is thinning out.

// ------------------------------------------------------------- the colour

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * One material PNG, laid over the ground at its own size in metres.
 *
 * Nearest sample, not bilinear: a material is a texture the ground is made of,
 * read at whatever scale the vertex grid happens to be, and interpolating it
 * only smears two threads of grass into one grey.
 */
export function sampleMaterial(img, tiling, x, z) {
    if (!img?.data) return null;
    const size = Math.max(0.01, Number(tiling) || 1);
    const u = ((x / size) % 1 + 1) % 1;
    const v = ((z / size) % 1 + 1) % 1;
    const i = Math.min(Math.floor(u * img.width), img.width - 1);
    const j = Math.min(Math.floor(v * img.height), img.height - 1);
    const k = (j * img.width + i) * 4;
    return [toLinear(img.data[k] / 255), toLinear(img.data[k + 1] / 255),
        toLinear(img.data[k + 2] / 255)];
}

// Rock shows through where the ground is steep and snow lies where it is high:
// two numbers on the class's own `paint` layer, not a biome system. Below the
// number the class is not there at all; a quarter of it above, it is all there.
function showing(paint, slope, height) {
    let on = 1;
    if (Number.isFinite(Number(paint?.above_slope))) {
        const want = Number(paint.above_slope) / 100;
        on *= clamp01((slope - want) / Math.max(0.01, want * 0.25) + 1);
    }
    if (Number.isFinite(Number(paint?.above_height))) {
        const want = Number(paint.above_height);
        on *= clamp01((height - want) / 60 + 1);
    }
    return on;
}

/**
 * What the ground looks like where a cover says what it is made of.
 *
 * @param {?object} cover readCover's answer
 * @param {object} how {paintOf, material, terrain, xOf, zOf}
 *   `paintOf(class)` the class's own `paint` parameters, `material(san)` the
 *   decoded PNG of one, `terrain` for the slope and height at a vertex, and
 *   `xOf`/`zOf` where a (u, v) of the grid is in the tile's own metres.
 * @returns {?function(number, number): ?number[]} linear RGB, or null where
 *   nothing mapped reaches — the ground keeps the colour it had.
 */
export function coverColour(cover, how) {
    if (!cover?.classes?.length) return null;
    const paints = cover.classes.map((c) => how.paintOf?.(c) ?? null);
    if (paints.every((p) => !p?.material)) return null;
    return (u, v) => {
        const x = how.xOf(u);
        const z = how.zOf(v);
        const slope = how.terrain?.slopeAt?.(x, z) ?? 0;
        const height = (how.terrain?.at?.(x, z) ?? 0) + (how.terrain?.datum ?? 0);
        const out = [0, 0, 0];
        let sum = 0;
        for (const [c, w0] of cover.weightsAt(u, v)) {
            const paint = paints[c];
            if (!paint?.material) continue;
            const w = w0 * showing(paint, slope, height);
            if (w <= 0) continue;
            const rgb = sampleMaterial(how.material?.(paint.material), paint.tiling, x, z);
            if (!rgb) continue;
            for (let k = 0; k < 3; k++) out[k] += rgb[k] * w;
            sum += w;
        }
        return sum > 0 ? out.map((c) => c / sum) : null;
    };
}

/**
 * How thickly a class is scattered at a point: its share of the ground there,
 * so a forest edge thins out instead of stopping at a pixel.
 */
export function thinningOf(cover, index, how) {
    if (!cover?.classes?.length) return null;
    return (x, z) => {
        const u = how.uOf(x);
        const v = how.vOf(z);
        for (const [c, w] of cover.weightsAt(u, v)) if (c === index) return w;
        return 0;
    };
}

// ------------------------------------------------------ the cover as a map

/**
 * The tile's cover as a picture: the colour the ground was drawn in, at one
 * pixel per cell of a square grid.
 *
 * FND.13 asks for a small `cover` atom after publish to write this. It is
 * written here instead, in the tar `assemble` already carries the height and
 * the colliders in, and published by `sog` with them — the same path, already
 * proven, and one atom rather than two. What the map and QGIS read is a file
 * beside the tile, which is what the task is about.
 *
 * Transparent where nothing mapped reaches, so a world with no cover leaves
 * the map as it was.
 *
 * @param {?function(number, number): ?number[]} colourAt linear RGB at (u, v)
 * @param {number} size pixels across
 * @returns {?Uint8Array} RGBA, row-major, north-west first
 */
export function coverPicture(colourAt, size) {
    if (!colourAt) return null;
    const out = new Uint8Array(size * size * 4);
    const gamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    let any = false;
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const rgb = colourAt(i / (size - 1), j / (size - 1));
            if (!rgb) continue;
            const k = (j * size + i) * 4;
            for (let c = 0; c < 3; c++) {
                out[k + c] = Math.round(clamp01(gamma(rgb[c])) * 255);
            }
            out[k + 3] = 255;
            any = true;
        }
    }
    return any ? out : null;
}
