// assembleload.js — everything one tile is made of, fetched.
//
// Split out of client/atoms/assemble.js, which is the building. This is the
// asking: the elevation, what the ground looks like from above, the cover, the
// shaped ground of every land the tile touches, and the products the pinned
// symbols name. A file that will not load is skipped rather than fatal — one
// lost product must not make a tile uncompilable.

import { fillVoids, loadDemDeeper, loadImage, sampleRgb } from '../lib/geo.js';
import { loadMaterials } from '../lib/gen/cover.js';
import { readR32 } from '../lib/r32.js';
import { toLocal } from './assemblelocal.js';
import { localFromLonLat, tileBbox, tileFrame } from '../lib/tilemath.js';

export { loadMaterials };

// What the ground looks like where the operator has said so (db/0106): the
// albedo's colour, dimmed by the shade where there is one. Null without an
// albedo, and the ramp by height and slope answers instead.
export async function groundColour(z, x, y, filesUrl) {
    const albedo = await loadImage('albedo', z, x, y, { filesUrl });
    const shade = albedo ? await loadImage('shade', z, x, y, { filesUrl }) : null;
    if (!albedo) return null;
    return (u, v) => {
        const base = sampleRgb(albedo, u, v);
        const dim = base && shade ? sampleRgb(shade, u, v) : null;
        return dim ? base.map((c, k) => c * dim[k]) : base;
    };
}

// The files the pinned symbols name (db/0161): a segment's or a model's GLB,
// a cross-section's or a collection's JSON, a material's PNG. Fetched by
// digest like an instance's GLB, once each, and a missing one is skipped
// rather than fatal — one lost product must not make a tile uncompilable.
const EXT = { model: 'glb', segment: 'glb', material: 'png',
    profile: 'json', collection: 'json' };

export async function loadProducts(files, filesUrl) {
    const out = new Map();
    for (const [san, what] of Object.entries(files ?? {})) {
        const ext = EXT[what.type] ?? 'glb';
        const res = await fetch(`${filesUrl}/assets/${what.sha256}.${ext}`).catch(() => null);
        if (!res?.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        out.set(san, { type: what.type, bytes,
            json: ext === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : null });
    }
    return out;
}

// The lands here that somebody has shaped: the grid each one saved and its own
// outline, in this tile's frame. A file that will not load is skipped, as a
// missing GLB is — one lost file must not make a tile uncompilable.
export async function loadGround(edits, frame, filesUrl) {
    const out = [];
    for (const e of edits ?? []) {
        const res = await fetch(`${filesUrl}/assets/${e.sha256}.r32`).catch(() => null);
        if (!res?.ok) continue;
        const local = toLocal(frame, { id: e.area_id, kind: 'area', geom: e.geom });
        out.push({ grid: readR32(new Uint8Array(await res.arrayBuffer())),
            contains: local.contains });
    }
    return out;
}

// Everything about where this tile is and what the ground under it looks
// like, before a single feature is read.
// `deeper` is how many zooms below the tile's own its ground is cut at
// (client/lib/geo.js loadDemDeeper): the atom's `dem_deeper`, one by default.
export async function theGround(z, x, y, filesUrl, wantCover = false, deeper = 1) {
    deeper = Number(deeper);
    // This tile's own cut, never an ancestor's (client/lib/geo.js loadDemExact).
    // A z14 read from z10 holds sixteen of this tile's samples, stretched over
    // a 513-vertex mesh: the quilt of bilinear triangles a player saw in the
    // frames. The mesh becomes the frames and the frames become the tile, so a
    // coarse read here is not a slightly softer tile, it is a tile trained
    // against a smear — and the store answers 404 for a tile outside the
    // coverage's own envelope as well as for one outside the world, so the
    // fall was silent.
    const dem = await loadDemDeeper(z, x, y, deeper, { filesUrl });
    if (!dem) {
        throw new Error(`no ground cut at ${z}/${x}/${y}: the store has no elevation `
            + 'for this tile at this zoom — either it is outside the coverage, or the '
            + 'coverage refused the cut. A coarser one would make a quilt of it.');
    }
    // The survey's own holes, closed before they become geometry: a void is
    // written as zero and the datum is subtracted from it, so an unfilled one
    // is a two-kilometre pit that the frames see sky through (geo.js
    // fillVoids).
    fillVoids(dem);
    const colourAt = await groundColour(z, x, y, filesUrl);
    // FND.12: the class raster, composed from the operator's cover sources by
    // the store (server/splatworld/ground.py). Only asked for when the applied
    // style has a mapping to read it with — a world with no cover keeps the
    // ramp it always had, and asks the store nothing.
    const coverImg = wantCover
        ? await loadImage('cover', z, x, y, { filesUrl }) : null;
    const b = tileBbox(z, x, y);
    const flat = tileFrame(z, x, y, 0);
    const frame = tileFrame(z, x, y, sampleGround(dem));
    return { b, dem, colourAt, coverImg, flat, frame,
        centre: { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 },
        sw: localFromLonLat(frame, b.west, b.south),
        ne: localFromLonLat(frame, b.east, b.north) };
}

const sampleGround = (dem) => {
    const n = dem.size;
    const u = dem.u0 + dem.span / 2;
    const v = dem.v0 + dem.span / 2;
    const i = Math.min(n - 1, Math.max(0, Math.round(u * n - 0.5)));
    const j = Math.min(n - 1, Math.max(0, Math.round(v * n - 0.5)));
    return dem.data[j * n + i];
};
