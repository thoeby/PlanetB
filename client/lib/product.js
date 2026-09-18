// product.js — what a product that is not a model is made of.
//
// FND.5: the catalog holds five kinds of thing. A model and a segment are a
// GLB; a material is a PNG; a profile and a collection are the JSON written
// here. All five are named by the sha256 of their own bytes (Invariant 1), so
// this has to be canonical: the same cross-section typed twice, in either
// order, is one file and one catalog entry.
//
// Pure. No DOM, no fetch — client/js/catalog.js does the storing.

// A strip of a road's cross-section: how far from the centre it starts, how
// wide it is, how high it stands off the ground, and what it is made of.
// Rounded to the millimetre, because a surveyor types centimetres and two
// people typing the same road must land on the same file.
const mm = (v) => Math.round(Number(v) * 1000) / 1000;

export function canonStrip(strip) {
    return {
        offset: mm(strip.offset ?? 0),
        width: mm(strip.width ?? 0),
        height: mm(strip.height ?? 0),
        material: String(strip.material ?? ''),
    };
}

/**
 * A road's cross-section, canonically. Strips are sorted by where they are, so
 * the order they were typed in does not change the file.
 *
 * @param {{strips: object[], mirrored?: boolean}} profile
 */
export function canonProfile({ strips = [], mirrored = false } = {}) {
    const out = strips.map(canonStrip)
        .filter((s) => s.width > 0)
        .sort((a, b) => a.offset - b.offset || a.width - b.width
            || a.material.localeCompare(b.material));
    return { kind: 'profile', version: 1, mirrored: Boolean(mirrored), strips: out };
}

// Every strip the compiler lays, mirrored ones included: what `mirrored` means,
// said once here rather than in each reader.
export function stripsOf(profile) {
    const strips = profile?.strips ?? [];
    if (!profile?.mirrored) return strips;
    const other = strips
        .filter((s) => s.offset !== 0)
        .map((s) => ({ ...s, offset: -s.offset }));
    return [...strips, ...other].sort((a, b) => a.offset - b.offset);
}

// How wide the whole section is, edge to edge, in metres.
export function profileWidth(profile) {
    const all = stripsOf(profile);
    if (!all.length) return 0;
    const lo = Math.min(...all.map((s) => s.offset - s.width / 2));
    const hi = Math.max(...all.map((s) => s.offset + s.width / 2));
    return mm(hi - lo);
}

/**
 * A collection, canonically: which models, in what proportions. Sorted by SAN,
 * so the order they were picked in does not change the file.
 *
 * @param {{san: string, weight?: number}[]} members
 */
export function canonCollection(members = []) {
    const out = members
        .map((m) => ({ san: String(m.san), weight: mm(m.weight ?? 1) }))
        .filter((m) => /^S[A-Z2-7]{12}$/.test(m.san) && m.weight > 0)
        .sort((a, b) => a.san.localeCompare(b.san));
    return { kind: 'collection', version: 1, members: out };
}

// The bytes of a description, and nothing else: JSON with the keys in the
// order they are written above, no spaces, one newline at the end.
export const describe = (thing) => new TextEncoder().encode(`${JSON.stringify(thing)}\n`);

// What a material must be, said once: the page checks it before the upload and
// db/0137 checks it again (Invariant 6). Returns a sentence, or ''.
export function materialTrouble({ width, height, tiling }) {
    if (!width || width !== height) return 'a surface material is a square png';
    if (width > 2048) return `a surface material is at most 2048 px, not ${width}`;
    if ((width & (width - 1)) !== 0) {
        return `a surface material is a power of two: ${width} is not`;
    }
    if (!(Number(tiling) > 0)) return 'a surface material needs a tiling size in metres';
    return '';
}

// And what a repeating piece must be: long enough to repeat.
export function segmentTrouble(bbox) {
    const length = (bbox?.max?.[0] ?? 0) - (bbox?.min?.[0] ?? 0);
    if (!(length >= 0.1)) {
        return `a repeating piece must be at least 0.10 m long, not ${length.toFixed(2)}`;
    }
    return '';
}

export const repeatsEvery = (bbox) =>
    `repeats every ${((bbox?.max?.[0] ?? 0) - (bbox?.min?.[0] ?? 0)).toFixed(2)} m`;
