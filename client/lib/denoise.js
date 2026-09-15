// denoise.js — the noise left by a few dozen paths a pixel, smoothed along
// the surfaces and not across their edges.
//
// An à-trous wavelet filter with edge stops (Dammertz et al. 2010, the
// cheap half of SVGF): three passes of a 5x5 B3-spline kernel at stride
// 1, 2, 4, each tap weighted down where the normal turns or the colour
// jumps. Normals come from a raster pass of the same scene, so an edge in
// the geometry stays an edge and a flat face becomes flat. Plain JS over
// float RGB, deterministic, about a tenth of a second at 512 px.

const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];

export const DEFAULTS = { passes: 3, sigmaColour: 0.12, normalPower: 64 };

function pass(src, dst, normals, n, step, { sigmaColour, normalPower }) {
    const sc = 2 * sigmaColour * sigmaColour;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const c = (y * n + x);
            const nx = normals[c * 3]; const ny = normals[c * 3 + 1]; const nz = normals[c * 3 + 2];
            const r0 = src[c * 3]; const g0 = src[c * 3 + 1]; const b0 = src[c * 3 + 2];
            let r = 0; let g = 0; let b = 0; let sum = 0;
            for (let j = -2; j <= 2; j++) {
                const yy = y + j * step;
                if (yy < 0 || yy >= n) continue;
                for (let i = -2; i <= 2; i++) {
                    const xx = x + i * step;
                    if (xx < 0 || xx >= n) continue;
                    const q = yy * n + xx;
                    const dn = Math.max(0, nx * normals[q * 3] + ny * normals[q * 3 + 1]
                        + nz * normals[q * 3 + 2]);
                    const dr = src[q * 3] - r0; const dg = src[q * 3 + 1] - g0;
                    const db = src[q * 3 + 2] - b0;
                    const w = KERNEL[i + 2] * KERNEL[j + 2] * dn ** normalPower
                        * Math.exp(-(dr * dr + dg * dg + db * db) / sc);
                    r += src[q * 3] * w; g += src[q * 3 + 1] * w; b += src[q * 3 + 2] * w;
                    sum += w;
                }
            }
            dst[c * 3] = sum ? r / sum : r0;
            dst[c * 3 + 1] = sum ? g / sum : g0;
            dst[c * 3 + 2] = sum ? b / sum : b0;
        }
    }
}

// rgb: Float32Array n*n*3, linear. normals: Float32Array n*n*3, unit, with a
// zero normal where nothing was drawn (the sky), which stops every tap and
// leaves the sky as it was. Returns a new array.
export function denoise(rgb, normals, n, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    let a = Float32Array.from(rgb);
    let b = new Float32Array(rgb.length);
    for (let k = 0; k < o.passes; k++) {
        pass(a, b, normals, n, 2 ** k, o);
        [a, b] = [b, a];
    }
    return a;
}

// The raster pass's bytes (MeshNormalMaterial: n * 0.5 + 0.5, alpha 0 where
// nothing was drawn) as unit normals, bottom-up rows as readPixels gives them.
export function normalsFrom(bytes, n) {
    const out = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
        if (!bytes[i * 4 + 3]) continue;
        const x = bytes[i * 4] / 127.5 - 1; const y = bytes[i * 4 + 1] / 127.5 - 1;
        const z = bytes[i * 4 + 2] / 127.5 - 1;
        const len = Math.hypot(x, y, z) || 1;
        out[i * 3] = x / len; out[i * 3 + 1] = y / len; out[i * 3 + 2] = z / len;
    }
    return out;
}
