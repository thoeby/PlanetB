// assemble.js — `assemble-v9`. The world, as geometry, in one tile's own frame.
//
// Terrain from the seeded DEM, cut by terrainmods and roads; footprints
// extruded; forests scattered; water laid flat; the ground coloured by its own
// ground and blended by slope and height. Out come four files in one tar:
//
//   scene.json   what the scene is, and where every buffer lives in mesh.bin
//   mesh.bin     positions, normals, colours and indices, one mesh per material
//   init.ply     area-weighted surface samples at 30 % of the tile's budget —
//                where `train` starts from, and what `sample` publishes as is
//   height.r16   the ground the player walks on
//   colliders.json  the boxes the player bumps into
//
// Deterministic (Invariant 2): the world arrives ordered by id, the scatter is
// seeded from the atom, and the tar carries no timestamps.

import { fetchJson } from '../js/api.js';
import { fillVoids, loadDemExact, loadImage, sampleRgb } from '../lib/geo.js';
import { loadAssets } from '../lib/assets.js';
import { boundsOf, placeMeshes } from '../lib/glbmesh.js';
import { packMeshes } from '../lib/mesh.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { contains } from '../lib/poly.js';
import { MATERIALS } from '../lib/props.js';
import { context, runAll } from '../lib/gen/index.js';
import { rngOf, sampleSurfaces } from '../lib/sampling.js';
import { writeTar } from '../lib/tar.js';
import {
    GRID, Terrain, applyHeightEdits, cutRoads, heightRaster, openHeights,
    terrainMesh,
} from '../lib/terrain.js';
import { readR32 } from '../lib/r32.js';
import { localFromLonLat, lonLatFromLocal, tileBbox, tileFrame } from '../lib/tilemath.js';

// v4 writes each surface's own colour and leaves the light to the one
// renderer (client/lib/raster.js); v3 had baked it for a sampled baseline
// that is gone. The cut elevation is read whole (terrain.js GRID).
export const ALGO = 'assemble-v9';

// What assemble and sample both use to turn surfaces into splats; re-exported
// because both atoms have always reached for them here.
export { rngOf, sampleSurfaces } from '../lib/sampling.js';
const INIT_SHARE = 0.3;

// ---------------------------------------------------------------- the world

const ringsOf = (geom, pt) => {
    if (geom.type === 'Polygon') return geom.coordinates.map((r) => r.map(pt));
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat().map((r) => r.map(pt));
    return [];
};

const linesOf = (geom, pt) => {
    if (geom.type === 'LineString') return [geom.coordinates.map(pt)];
    if (geom.type === 'MultiLineString') return geom.coordinates.map((l) => l.map(pt));
    return [];
};

// GeoJSON closes a ring by repeating its first point; nothing here wants that.
const open = (ring) => (ring.length > 1
    && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? ring.slice(0, -1) : ring);

function toLocal(frame, feature) {
    const pt = ([lon, lat]) => {
        const p = localFromLonLat(frame, lon, lat);
        return [p.x, p.z];
    };
    const rings = ringsOf(feature.geom, pt).map(open).filter((r) => r.length >= 3);
    return {
        id: feature.id,
        kind: feature.kind,
        props: feature.props ?? {},
        rings,
        lines: linesOf(feature.geom, pt),
        contains: (x, z) => contains(rings, x, z),
    };
}

// A feature that crosses the tile's edge arrives whole — a road runs for
// kilometres, a forest spills into the next tile — and a tile shows its own
// ground and nothing else. A triangle is kept only if all of it is inside, so
// what comes out is bounded by this box and submit_atom's bbox rule holds. The
// margin is what makes neighbouring tiles meet rather than leave a seam.
const CLIP_M = 8;

function clip(meshes, sw, ne) {
    const inside = (i, m) => m.positions[i * 3] >= sw.x - CLIP_M
        && m.positions[i * 3] <= ne.x + CLIP_M
        && m.positions[i * 3 + 2] <= sw.z + CLIP_M
        && m.positions[i * 3 + 2] >= ne.z - CLIP_M;
    for (const m of meshes) {
        const kept = [];
        for (let i = 0; i < m.indices.length; i += 3) {
            const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
            if (inside(a, m) && inside(b, m) && inside(c, m)) kept.push(a, b, c);
        }
        m.indices = kept;
    }
    return meshes.filter((m) => m.indices.length);
}

// ------------------------------------------------------------- placed assets

// An instance is a catalog asset standing on the ground (WP4.2); its GLB
// comes from client/lib/assets.js, once per digest.

// canon-v1 re-centred every asset on the bottom centre of its bounding box, so
// an instance's position is where it stands, and its box is that box moved.
// FND.6: a screen's content is not the compiler's to bake — the frame around it
// is geometry like any other, the surface it carries is live. Everything else a
// marked part may do (a light's glow, a door's pose) is either not baked at all
// or baked where the maker left it.
const liveSurfaces = (parts) => new Set((parts?.parts ?? [])
    .filter((p) => p.role === 'screen').map((p) => p.name));

// FND.11: where a placed model takes the ground away — the box its opening's
// own triangles cover, in the tile's frame.
function openingsOf(placed) {
    const out = [];
    for (const m of placed) {
        if (!m.opening) continue;
        let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < m.positions.length; i += 3) {
            x0 = Math.min(x0, m.positions[i]);
            x1 = Math.max(x1, m.positions[i]);
            z0 = Math.min(z0, m.positions[i + 2]);
            z1 = Math.max(z1, m.positions[i + 2]);
        }
        if (Number.isFinite(x0)) out.push([x0, z0, x1, z1]);
    }
    return out;
}

function placeInstances(instances, assets, frame) {
    const meshes = [];
    const boxes = [];
    const openings = [];
    let missing = 0;
    for (const i of instances ?? []) {
        const glb = assets.get(i.sha256);
        if (!glb) { missing += 1; continue; }
        const p = localFromLonLat(frame, i.lon, i.lat, i.h ?? 0);
        const at = [p.x, p.y, p.z];
        const placed = placeMeshes(glb, { at, yaw: i.yaw ?? 0, pitch: i.pitch ?? 0,
            roll: i.roll ?? 0, scale: i.scale ?? 1, material: 'asset',
            skip: liveSurfaces(i.parts) });
        openings.push(...openingsOf(placed));
        meshes.push(...placed);
        boxes.push(colliderOf(placed, at));
    }
    return { meshes, boxes, openings, missing };
}

function colliderOf(meshes, at) {
    const { min, max } = boundsOf(meshes.map((m) => ({ positions: m.positions })));
    return {
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
        yaw: 0,
        at,
    };
}

// The scene itself: ground first, then everything that stands on it.
// What the ground looks like where the operator has said so (db/0106): the
// albedo's colour, dimmed by the shade where there is one. Null without an
// albedo, and the ramp by height and slope answers instead.
async function groundColour(z, x, y, filesUrl) {
    const albedo = await loadImage('albedo', z, x, y, { filesUrl });
    const shade = albedo ? await loadImage('shade', z, x, y, { filesUrl }) : null;
    if (!albedo) return null;
    return (u, v) => {
        const base = sampleRgb(albedo, u, v);
        const dim = base && shade ? sampleRgb(shade, u, v) : null;
        return dim ? base.map((c, k) => c * dim[k]) : base;
    };
}

// What a feature becomes is decided by the world's symbols, which travel with
// it (db/0161): nothing here knows what a road, a wood or a roof is. Each
// feature is put through the first symbol that matches it, and that symbol's
// layers draw it (client/lib/gen/).
function build({ z, sw, ne, dem, frame, world, random, assets, products,
    ground = [], colourAt = null }) {
    const symbols = world.symbols ?? [];
    const feats = (world.features ?? []).map((f) => toLocal(frame, f));
    const terrain = new Terrain({ sw, ne, size: GRID[z] ?? 65, dem });
    // The frame's origin is the ground under the tile centre, so heights are
    // measured from there, not from the ellipsoid.
    for (let i = 0; i < terrain.h.length; i++) terrain.h[i] -= frame.h;
    terrain.datum = frame.h;
    // FND.9: what the lands here were shaped into, before anything stands on
    // it. PLAN-foundation.md §3's first step.
    applyHeightEdits(terrain, ground, (x, z0) => lonLatFromLocal(frame, { x, y: 0, z: z0 }));

    const edge = Math.hypot(ne.x - sw.x, sw.z - ne.z);
    const ctx = context({ terrain, random, radius: Math.max(6, edge / 140),
        asset: (san) => products?.get(san)?.bytes ?? null,
        product: (san) => products?.get(san)?.json ?? null,
        // The roads every `surface` layer gathered, cut into the hill before
        // anything is drawn on it.
        cut: () => cutRoads(terrain, ctx.roads) });
    // The models are placed before the ground is built: where one of them
    // opens the terrain, the terrain is not built there at all (FND.11).
    const placed = placeInstances(world.instances, assets ?? new Map(), frame);
    const drawn = runAll(symbols, feats, ctx);
    const meshes = clip([terrainMesh(terrain, 'terrain', colourAt, placed.openings),
        ...drawn.meshes, ...placed.meshes], sw, ne);
    const boxes = [...drawn.boxes, ...placed.boxes]
        .filter((b) => b.center[0] >= sw.x - CLIP_M
            && b.center[0] <= ne.x + CLIP_M && b.center[2] <= sw.z + CLIP_M
            && b.center[2] >= ne.z - CLIP_M);
    return { terrain, meshes, boxes, trees: ctx.trees, flags: drawn.flags,
        paints: ctx.paints, roads: ctx.roads, placed,
        openings: placed.openings };
}

// The files the pinned symbols name (db/0161): a segment's or a model's GLB,
// a cross-section's or a collection's JSON, a material's PNG. Fetched by
// digest like an instance's GLB, once each, and a missing one is skipped
// rather than fatal — one lost product must not make a tile uncompilable.
const EXT = { model: 'glb', segment: 'glb', material: 'png',
    profile: 'json', collection: 'json' };

async function loadProducts(files, filesUrl) {
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
async function loadGround(edits, frame, filesUrl) {
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
async function theGround(z, x, y, filesUrl) {
    // This tile's own cut, never an ancestor's (client/lib/geo.js loadDemExact).
    // A z14 read from z10 holds sixteen of this tile's samples, stretched over
    // a 513-vertex mesh: the quilt of bilinear triangles a player saw in the
    // frames. The mesh becomes the frames and the frames become the tile, so a
    // coarse read here is not a slightly softer tile, it is a tile trained
    // against a smear — and the store answers 404 for a tile outside the
    // coverage's own envelope as well as for one outside the world, so the
    // fall was silent.
    const dem = await loadDemExact(z, x, y, { filesUrl });
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
    const b = tileBbox(z, x, y);
    const flat = tileFrame(z, x, y, 0);
    const frame = tileFrame(z, x, y, sampleGround(dem));
    return { b, dem, colourAt, flat, frame,
        centre: { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 },
        sw: localFromLonLat(frame, b.west, b.south),
        ne: localFromLonLat(frame, b.east, b.north) };
}

// -------------------------------------------------------------------- atom

export async function run({ atom, log, apiUrl, filesUrl }) {
    const { z, x, y, budget } = atom.params;
    const world = await fetchJson(`${apiUrl}/rpc/tile_world`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ z, x, y }),
    });
    // Invariant 2: this atom was built from one snapshot of the world. If the
    // world has moved, the job is already cancelled and this work is waste.
    if (atom.inputs?.snapshot && world.snapshot !== atom.inputs.snapshot) {
        throw new Error(`the world moved: ${world.snapshot} is not ${atom.inputs.snapshot}`);
    }

    const { centre, flat, frame, sw, ne, dem, colourAt } = await theGround(z, x, y, filesUrl);

    const assets = await loadAssets(world.instances, { filesUrl });
    const products = await loadProducts(world.symbol_files, filesUrl);
    const ground = await loadGround(world.height_edits, frame, filesUrl);
    const { terrain, meshes, boxes, trees, flags, roads, placed, openings } =
        build({ z, sw, ne, dem, frame, world, random: rngOf(atom, z, x, y),
            assets, products, ground, colourAt });
    log?.({ event: 'assembled', z, x, y, meshes: meshes.length, trees,
        buildings: boxes.length, roads: roads.length,
        instances: placed.meshes.length, missing: placed.missing });

    const random = rngOf(atom, z, x, y);
    const splats = sampleSurfaces(meshes, Math.round(budget * INIT_SHARE), random);
    // What the player walks on has the same holes in it.
    const height = heightRaster(openHeights(terrain, openings));
    const { bin, specs } = packMeshes(meshes);
    const scene = {
        algo: ALGO, tile: { z, x, y }, origin: { ...centre, h: frame.h },
        budget, materials: MATERIALS, meshes: specs, height: height.meta,
        instances: world.instances ?? [], snapshot: world.snapshot,
        counts: { trees, buildings: boxes.length, splats: splats.count },
        // The frame at ground level; the flat one is what tilemath gives for h=0.
        frame: { lon: frame.lon, lat: frame.lat, h: frame.h, flat_h: flat.h },
    };
    const tar = writeTar([
        { name: 'scene.json', bytes: new TextEncoder().encode(JSON.stringify(scene)) },
        { name: 'mesh.bin', bytes: bin },
        { name: 'init.ply', bytes: writePly(splats) },
        { name: 'height.r16', bytes: height.bytes },
        { name: 'colliders.json',
            bytes: new TextEncoder().encode(JSON.stringify({ boxes })) },
    ]);
    return {
        files: [{ ext: 'tar', kind: 'init_ply', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, splat_count: splats.count, finite: true,
            bbox: bboxOf(splats),
            trees, buildings: boxes.length, snapshot: world.snapshot,
            instances: (world.instances ?? []).length - placed.missing,
            // FND.11 reads these in the Submit dialog: where a road is laid
            // across a slope steeper than its symbol allows.
            flags,
        },
    };
}

// The tile's origin sits at the ground under its centre (ARCHITECTURE §2).
const sampleGround = (dem) => {
    const n = dem.size;
    const u = dem.u0 + dem.span / 2;
    const v = dem.v0 + dem.span / 2;
    const i = Math.min(n - 1, Math.max(0, Math.round(u * n - 0.5)));
    const j = Math.min(n - 1, Math.max(0, Math.round(v * n - 0.5)));
    return dem.data[j * n + i];
};
