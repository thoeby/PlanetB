// noise.js — value noise over world metres, the same number from any tile.
//
// The world's surface is one colour per band of height and slope, and one
// colour over a hectare is a painted floor. This is the grain: a hash of the
// integer lattice, smoothed, summed over octaves. It is keyed to where a point
// is on the planet (terrain.js worldMetres), not to where it is in a tile, so
// two tiles compute the same grain where they meet and the ground mesh
// computes it too. No state, no seed: the function of (x, z) is the world's.

const hash = (i, j) => {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const smooth = (t) => t * t * (3 - 2 * t);

// 0..1, smooth, period-free.
export function noise2(x, z) {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const u = smooth(x - i);
    const v = smooth(z - j);
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v)
        + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
}

// Octaves of it, each half the size and half the weight of the last,
// normalised to 0..1. `scale` is the metres of the largest.
export function fbm(x, z, scale, octaves = 4) {
    let sum = 0;
    let weight = 0;
    let f = 1 / scale;
    let a = 1;
    for (let o = 0; o < octaves; o++) {
        sum += noise2(x * f + o * 17.3, z * f - o * 11.7) * a;
        weight += a;
        f *= 2;
        a *= 0.5;
    }
    return sum / weight;
}
