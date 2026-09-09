// geo.js — the seeded inputs: /geo/dem/{z}/{x}/{y}.r16 and
// /geo/ortho/{z}/{x}/{y}.webp (infra/seed/README.md).
//
// A tile is not always cut at its own zoom — the seed covers z10..z14 and one
// deeper pocket — so a missing tile falls back to an ancestor and samples the
// rectangle this tile occupies inside it. Web-Mercator tiles nest exactly, so
// that rectangle is exact.

export const DEM_SCALE = 0.2;
export const DEM_OFFSET = -500;
const MIN_Z = 6;

// Where (z,x,y) sits inside its ancestor at az, in 0..1.
function subRect(z, x, y, az) {
    const f = 2 ** (z - az);
    const ax = Math.floor(x / f);
    const ay = Math.floor(y / f);
    return { az, ax, ay, u0: (x - ax * f) / f, v0: (y - ay * f) / f, span: 1 / f };
}

// The finest cut tile covering (z,x,y): itself, else an ancestor two zooms up,
// and so on. Returns null when nothing covers it — a 404 is that; any other
// failure is an error, not an absence.
export async function loadRaster(kind, z, x, y, { filesUrl = '', fetchFn = fetch, decode }) {
    for (let az = z; az >= MIN_Z; az -= 2) {
        const r = subRect(z, x, y, az);
        const ext = kind === 'dem' ? 'r16' : 'webp';
        const url = `${filesUrl}/geo/${kind}/${az}/${r.ax}/${r.ay}.${ext}`;
        const res = await fetchFn(url);
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        const { data, size } = await decode(await res.arrayBuffer());
        return { kind, size, data, ...r };
    }
    return null;
}

// Bilinear, on pixel centres: gdalwarp put pixel i at (i + 0.5) / size of the
// tile it cut, so that is where its value lives.
function bilinear(raster, u, v, stride, read) {
    const au = raster.u0 + u * raster.span;
    const av = raster.v0 + v * raster.span;
    const n = raster.size;
    const fx = Math.min(Math.max(au * n - 0.5, 0), n - 1);
    const fy = Math.min(Math.max(av * n - 0.5, 0), n - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, n - 1);
    const y1 = Math.min(y0 + 1, n - 1);
    const sx = fx - x0;
    const sy = fy - y0;
    const out = [];
    for (let c = 0; c < stride; c++) {
        const a = read((y0 * n + x0) * stride + c);
        const b = read((y0 * n + x1) * stride + c);
        const d = read((y1 * n + x0) * stride + c);
        const e = read((y1 * n + x1) * stride + c);
        out.push((a * (1 - sx) + b * sx) * (1 - sy) + (d * (1 - sx) + e * sx) * sy);
    }
    return out;
}

// dem-v1: uint16 counts, elevation_m = value * 0.2 - 500.
export const decodeDem = async (buf) => {
    const data = new Uint16Array(buf);
    return { data, size: Math.round(Math.sqrt(data.length)) };
};

export const loadDem = (z, x, y, opts) =>
    loadRaster('dem', z, x, y, { ...opts, decode: opts.decode ?? decodeDem });

export const sampleHeight = (dem, u, v) =>
    bilinear(dem, u, v, 1, (i) => dem.data[i])[0] * DEM_SCALE + DEM_OFFSET;

// WebP has no decoder in plain JS; the browser's is reachable from a worker
// through createImageBitmap and an OffscreenCanvas, which is where atoms run.
export async function decodeImage(buf, canvas) {
    const bitmap = await createImageBitmap(new Blob([buf]));
    // close() zeroes the bitmap's width, so take it first.
    const size = bitmap.width;
    const c = canvas(size, bitmap.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, size, bitmap.height);
    bitmap.close();
    return { data, size };
}

export const loadOrtho = (z, x, y, opts) => loadRaster('ortho', z, x, y, {
    ...opts,
    decode: opts.decode ?? ((buf) => decodeImage(buf, opts.canvas)),
});

export const sampleColor = (ortho, u, v) =>
    bilinear(ortho, u, v, 4, (i) => ortho.data[i]).slice(0, 3).map((c) => c / 255);
