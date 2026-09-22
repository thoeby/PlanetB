// geo.js — the ground: /geo/dem/{z}/{x}/{y}.r16, cut from the world's coverage
// by the server when a tab first asks for it (server/splatworld/ground.py).
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
//
// `exact` refuses the ancestors. A tile read from two zooms up holds sixteen
// of this tile's samples, and from four zooms up one: stretched over a 513
// mesh (client/lib/terrain.js GRID) that is a quilt of bilinear triangles,
// which is what a player saw in the frames. For a *floor* that is still
// better than nothing — any ground beats hanging in the air. For `assemble`
// it is not: the mesh becomes the frames, the frames become the tile, and
// nothing anywhere says the ground was coarse. The store answers 404 for a
// tile outside the coverage's own envelope as well as for one outside the
// world (server/splatworld/ground.py, "outside the coverage"), so the fall
// was silent and looked like detail that had simply not been trained yet.
// `version` is what the ground was last cut for (db/0154 recut_ground, the
// `set_at` ground_view carries). A cut is served immutable and for a year, so
// a browser that has one never asks again: the same ground under a new survey
// is the same URL, and every map in the tab went on drawing the hill that is
// not there any more. The version is that URL's only moving part.
export async function loadRaster(kind, z, x, y,
    { filesUrl = '', fetchFn = fetch, decode, exact = false, version = '' }) {
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    for (let az = z; az >= MIN_Z; az -= 2) {
        const r = subRect(z, x, y, az);
        const ext = kind === 'dem' ? 'r16' : 'png';
        const url = `${filesUrl}/geo/${kind}/${az}/${r.ax}/${r.ay}.${ext}${v}`;
        const res = await fetchFn(url);
        if (res.status === 404) { if (exact) return null; continue; }
        if (!res.ok) {
            // Whatever the store said, in the atom's error: the difference
            // between "no world here" and "the cut failed" is the difference
            // between drawing somewhere else and fixing your GeoServer.
            const said = await res.text().catch(() => '');
            throw new Error(`${res.status} ${url}${said ? ` — ${said}` : ''}`);
        }
        const { data, size } = await decode(await res.arrayBuffer());
        const raster = { kind, size, data, ...r };
        // The ancestor may hold ground and still hold none of *this* tile's.
        // A z14 reading a z10 file samples thirty-two of its pixels, and if
        // those are the ones the survey never reached they are all NODATA —
        // a constant, which assemble turns into a mesh flat at exactly y = 0
        // (it subtracts the centre sample from every height), and which the
        // trainer then keeps its splats against a box zero metres high. The
        // server refuses a cut that is nothing but fill; this refuses the
        // window that is, and goes on to a coarser ancestor that may cover it.
        if (kind === 'dem' && allNodata(raster)) continue;
        return raster;
    }
    return null;
}

// Cut at this tile's own zoom or not at all.
export const loadExact = (kind, z, x, y, opts) =>
    loadRaster(kind, z, x, y, { ...opts, exact: true });

// The voids inside a cut, filled from what surrounds them.
//
// A survey has holes in it: steep rock, snow, water, anything the sensor did
// not get a return from. The cut writes those as NODATA_ELEVATION_M, which is
// zero, and `assemble` subtracts the tile's own datum from every sample — so
// a void two thousand metres up becomes a vertex two thousand metres down.
// The mesh keeps every triangle (client/lib/terrain.js terrainMesh), so what
// it makes is not a hole but a pit with near-vertical walls: the frames see
// sky through it, the trainer learns the sky, and the tile comes back with
// holes in it that no number of steps will close.
//
// So the void is filled before anything looks at it: each pass gives every
// void sample the mean of the neighbours that have ground, and the ground
// creeps inward. It is not survey data and does not pretend to be — it is the
// surface a person would draw across a gap, which is what the frames need to
// see. A cut that is nothing but void never gets here (loadRaster refuses it).
export function fillVoids(dem, passes = 64) {
    const { data, size } = dem;
    let left = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === NODATA_ELEVATION_M) left++;
    if (!left || left === data.length) return dem;
    for (let pass = 0; pass < passes && left; pass++) {
        const next = data.slice();
        let filled = 0;
        for (let j = 0; j < size; j++) {
            for (let i = 0; i < size; i++) {
                const k = j * size + i;
                if (data[k] !== NODATA_ELEVATION_M) continue;
                let sum = 0;
                let n = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        const y = j + dj, x = i + di;
                        if (y < 0 || x < 0 || y >= size || x >= size) continue;
                        const v = data[y * size + x];
                        if (v !== NODATA_ELEVATION_M) { sum += v; n++; }
                    }
                }
                if (n) { next[k] = sum / n; filled++; }
            }
        }
        if (!filled) break;
        data.set(next);
        left -= filled;
    }
    // A void the creep never reached — a whole corner of the tile with no
    // ground anywhere near it — is levelled at what the tile does know,
    // because a pit is worse than a plateau.
    if (left) {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i++) {
            if (data[i] !== NODATA_ELEVATION_M) { sum += data[i]; n++; }
        }
        const flat = n ? sum / n : 0;
        for (let i = 0; i < data.length; i++) {
            if (data[i] === NODATA_ELEVATION_M) data[i] = flat;
        }
    }
    return dem;
}

// Elevation the cut writes where the survey did not reach (dem.NODATA_ELEVATION_M
// in server/splatworld/dem.py). A tile of it is not ground at sea level.
export const NODATA_ELEVATION_M = 0;

// Whether the rectangle this tile occupies inside `raster` holds no surveyed
// sample. Read on the pixels the sampling will actually touch, one row of the
// sub-rect at a time, so a tile beside the data is told from one inside it.
export function allNodata({ data, size, u0, v0, span }) {
    const lo = (t) => Math.max(0, Math.floor(t * size));
    const hi = (t) => Math.min(size, Math.ceil(t * size));
    const x1 = Math.max(hi(u0 + span), lo(u0) + 1);
    const y1 = Math.max(hi(v0 + span), lo(v0) + 1);
    for (let j = lo(v0); j < y1; j++) {
        for (let i = lo(u0); i < x1; i++) {
            if (data[j * size + i] !== NODATA_ELEVATION_M) return false;
        }
    }
    return true;
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

// dem-v2: float32 metres. dem-v1, which the store may still hold from an
// earlier cut or tools/seed-dem.sh: uint16 counts, metres = value * 0.2 - 500,
// told apart by the file's length. Either way `data` is metres.
export const decodeDem = async (buf) => {
    const n = Math.round(Math.sqrt(buf.byteLength / 4));
    if (n * n * 4 === buf.byteLength) {
        return { data: new Float32Array(buf), size: n };
    }
    const raw = new Uint16Array(buf);
    const data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw[i] * DEM_SCALE + DEM_OFFSET;
    return { data, size: Math.round(Math.sqrt(raw.length)) };
};

export const loadDem = (z, x, y, opts) =>
    loadRaster('dem', z, x, y, { ...opts, decode: opts.decode ?? decodeDem });

// The elevation for a tile that is about to become a mesh, its frames and a
// trained tile: this zoom's cut or nothing (loadRaster `exact`).
export const loadDemExact = (z, x, y, opts) =>
    loadRaster('dem', z, x, y, { ...opts, decode: opts.decode ?? decodeDem, exact: true });

export const sampleHeight = (dem, u, v) => bilinear(dem, u, v, 1, (i) => dem.data[i])[0];

// The tile's ground from the cuts `deeper` zooms down: the 2^deeper x 2^deeper
// descendants at z + deeper, each cut exactly, stitched into one raster of
// the tile. A cut is 512 samples across whatever its zoom, so a z14 tile at
// its own zoom is a 3.3 m grid over a half-metre survey, and the mesh built
// from it — which becomes the frames, which become the tile — had the relief
// of a 1990s game map: every fold in the hillside smaller than three metres
// was gone before the trainer ever saw it. One zoom deeper is four cuts and
// a 1024 grid; two is sixteen and 2048. Any descendant the store cannot cut
// (outside the coverage, or all void) puts the tile back on its own cut —
// coarse ground, not a quilt with a hole in it. The composite is the tile's
// own rectangle (u0 = v0 = 0, span = 1), so it samples like any other.
export async function loadDemDeeper(z, x, y, deeper, opts) {
    if (!(deeper > 0)) return loadDemExact(z, x, y, opts);
    const f = 2 ** deeper;
    const asked = [];
    for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
            asked.push(loadDemExact(z + deeper, x * f + i, y * f + j, opts));
        }
    }
    const cuts = await Promise.all(asked);
    if (cuts.some((c) => !c)) return loadDemExact(z, x, y, opts);
    const n = cuts[0].size;
    const size = n * f;
    const data = new Float32Array(size * size);
    cuts.forEach((c, k) => {
        const bi = (k % f) * n;
        const bj = Math.floor(k / f) * n;
        for (let r = 0; r < n; r++) {
            data.set(c.data.subarray(r * n, r * n + n), (bj + r) * size + bi);
        }
    });
    return { kind: 'dem', size, data, az: z, ax: x, ay: y, u0: 0, v0: 0, span: 1, deeper };
}

// An albedo or a shade (db/0106): the PNG the WMS drew, decoded with the
// worker's own OffscreenCanvas (decodeImage, below).
export const loadImage = (kind, z, x, y, opts) =>
    loadRaster(kind, z, x, y, {
        ...opts,
        decode: opts.decode ?? ((b) => decodeImage(b, (w, h) => new OffscreenCanvas(w, h))),
    });

// The picture's colour at (u, v) as linear RGB 0..1, or null where the
// picture is transparent — outside the layer's data.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function sampleRgb(img, u, v) {
    const [r, g, b, a] = bilinear(img, u, v, 4, (i) => img.data[i]);
    if (a < 128) return null;
    return [toLinear(r / 255), toLinear(g / 255), toLinear(b / 255)];
}

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


