// cover.js — what the ground is made of, before anything stands on it.
//
// FND.12. A cover source is a class raster: one colour per class, transparent
// where the source says nothing (server/splatworld/ground.py cuts it). What a
// colour *means* is the operator's mapping — this one is `landuse=forest` —
// and what a `landuse=forest` looks like is that kind's symbol, its `paint`
// layer (db/0161). So nothing here knows what a forest is either.
//
// Borders are not where the raster steps. Each class gets an exact Euclidean
// distance field, and a pixel near two classes is partly both, over the width
// the class's own symbol asks for, wobbled by noise seeded from the tile. That
// is what makes a forest edge a gradient rather than a staircase — in the
// ground's colour and in how thickly it is scattered.
//
// Deterministic (Invariant 2): the raster is the tile's, the mapping is the
// one the style pinned, and the noise is seeded from the tile's own numbers.

import { decodePng } from '../png.js';
import { paramsOf, symbolFor } from './index.js';

export const COVER_ALGO = 'cover-v1';

export const hexOf = (r, g, b) =>
    `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// The mapping is written against the colour a source paints a class with
// (db/0166) — the panel writes the style that paints it, so the two agree by
// construction. Sources are consulted in the order the world cut them, so a
// colour two of them share means what the first one says.
function mapOf(sources) {
    const out = new Map();
    for (const s of sources ?? []) {
        for (const [key, what] of Object.entries(s.class_map ?? {})) {
            const at = key.startsWith('#') ? key.toLowerCase() : key;
            if (!out.has(at)) out.set(at, { ...what, source: s.layer });
        }
    }
    return out;
}

// One pass of the exact squared Euclidean distance transform (Felzenszwalb &
// Huttenlocher), along one axis. `f` is the cost at each sample; the answer is
// the lower envelope of the parabolas it raises.
function edt1d(f, n) {
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k -= 1;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k += 1;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    return d;
}

/**
 * Distance in pixels from every pixel to the nearest one where `is` holds.
 * Exact, and the same everywhere: no approximation, no iteration count.
 */
export function distanceField(is, width, height) {
    const big = (width + height) ** 2;
    const f = new Float64Array(Math.max(width, height));
    const d = new Float64Array(width * height);
    for (let i = 0; i < d.length; i++) d[i] = is(i) ? 0 : big;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) f[y] = d[y * width + x];
        const col = edt1d(f, height);
        for (let y = 0; y < height; y++) d[y * width + x] = col[y];
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) f[x] = d[y * width + x];
        const row = edt1d(f, width);
        for (let x = 0; x < width; x++) d[y * width + x] = Math.sqrt(row[x]);
    }
    return d;
}

// Value noise over the tile: one number per lattice cell, smoothly blended.
// Seeded from the tile's own coordinates, so two tabs building the same tile
// wobble the same edge the same way (Invariant 2).
function valueNoise(seed) {
    const at = (i, j) => {
        let h = (i * 374761393 + j * 668265263 + seed * 2246822519) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const fade = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
        const i = Math.floor(x);
        const j = Math.floor(y);
        const sx = fade(x - i);
        const sy = fade(y - j);
        const a = at(i, j) * (1 - sx) + at(i + 1, j) * sx;
        const b = at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx;
        return a * (1 - sy) + b * sy;
    };
}

/**
 * The cover of one tile: which classes are in it, and how much of each is at
 * any point of it.
 *
 * @param {?object} img the cut raster, decoded (client/lib/geo.js loadImage)
 * @param {object[]} sources the applied mapping (db/0166 pinned_cover)
 * @param {object} how {seed, metres, blendOf} — the tile's own noise seed, how
 *        wide the tile is in metres, and the blend width one class asks for
 * @returns {?object} null when no source reaches this tile
 */
export function readCover(img, sources, how = {}) {
    if (!img?.data) return null;
    const mapped = mapOf(sources);
    const n = img.size;
    const codes = new Int16Array(n * n).fill(-1);
    const classes = [];
    const at = new Map();
    const unmapped = new Map();
    for (let i = 0; i < n * n; i++) {
        if (img.data[i * 4 + 3] < 128) continue;
        const hex = hexOf(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
        const what = mapped.get(hex);
        if (!what) {
            unmapped.set(hex, (unmapped.get(hex) ?? 0) + 1);
            continue;
        }
        if (!at.has(hex)) {
            at.set(hex, classes.length);
            classes.push({ hex, ...what });
        }
        codes[i] = at.get(hex);
    }
    if (!classes.length) {
        return { classes: [], unmapped: [...unmapped.keys()].sort(), weightsAt: () => [] };
    }
    return blended(codes, classes, n, unmapped, how);
}

// The distance field of every class, and the reading of them. `metres` is how
// wide the whole raster is, so a blend asked for in metres is a blend in
// pixels here.
function blended(codes, classes, n, unmapped, how) {
    const metres = Number(how.metres) || 1;
    const perPixel = metres / n;
    const noise = valueNoise(Number(how.seed) || 1);
    const fields = classes.map((_, c) => distanceField((i) => codes[i] === c, n, n));
    const widths = classes.map((c) => Math.max(0.01,
        Number(how.blendOf?.(c)) || 1) / perPixel);
    const wobble = Math.max(1, 6 / perPixel);
    return {
        classes,
        unmapped: [...unmapped.keys()].sort(),
        unmappedCounts: unmapped,
        // u, v in 0..1 across the tile, north-west first, as every other
        // raster in this world is read.
        weightsAt(u, v) {
            const x = Math.min(Math.max(u * (n - 1), 0), n - 1);
            const y = Math.min(Math.max(v * (n - 1), 0), n - 1);
            const k = Math.round(y) * n + Math.round(x);
            const jitter = (noise(x / wobble, y / wobble) - 0.5) * 2;
            const out = [];
            let sum = 0;
            for (let c = 0; c < classes.length; c++) {
                const d = fields[c][k] + jitter * widths[c] * 0.5;
                const w = Math.max(0, 1 - d / widths[c]);
                if (w > 0) { out.push([c, w]); sum += w; }
            }
            if (!sum) return [];
            return out.map(([c, w]) => [c, w / sum]);
        },
    };
}

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

// ------------------------------------------------- the cover as features

// FND.12: the ground cover, as features. A class the operator mapped is a
// patch of `landuse=forest` over this tile, so it meets the world's symbols
// exactly as a drawn forest does — the same `paint`, the same `scatter`. What
// makes it a cover rather than a shape is `thin`: how much of the ground the
// class actually holds at a point, which is what makes an edge an edge.
export function coverFeatures(cover, sw, ne) {
    const rings = [[[sw.x, sw.z], [ne.x, sw.z], [ne.x, ne.z], [sw.x, ne.z]]];
    const uOf = (x) => (x - sw.x) / ((ne.x - sw.x) || 1);
    const vOf = (z) => (z - ne.z) / ((sw.z - ne.z) || 1);
    return (cover?.classes ?? []).map((c, at) => ({
        id: `cover:${c.hex}`,
        kind: c.kind,
        props: { [c.key]: c.value },
        rings,
        lines: [],
        contains: () => true,
        thin: thinningOf(cover, at, { uOf, vOf }),
    }));
}

// Enough of a class for a symbol to be matched against it and its parameters
// read: the kind and the one property the mapping says it is.
export const coverOne = (c) => ({ kind: c.kind, props: { [c.key]: c.value },
    rings: [], lines: [] });

// A class's own `paint` layer — the material it is made of, how far it blends
// into its neighbours, and the slope or height it only shows above.
export const paintOf = (symbols, feature) => {
    const symbol = symbolFor(symbols, feature);
    const layer = (symbol?.layers ?? []).find(
        (l) => l.layer === 'paint' && l.enabled !== false);
    return layer ? paramsOf(layer, feature) : null;
};

/**
 * The material PNGs the cover's classes are made of, decoded once each.
 *
 * `assemble` has already fetched every product a pinned symbol names
 * (`symbol_files`); this is only the decoding, and a picture that will not
 * decode is skipped rather than fatal — one broken material must not make a
 * tile uncompilable.
 */
export async function loadMaterials(products) {
    const out = new Map();
    for (const [san, what] of products ?? []) {
        if (what?.type !== 'material' || !what.bytes) continue;
        const img = await decodePng(what.bytes).catch(() => null);
        if (img) out.set(san, img);
    }
    return out;
}
