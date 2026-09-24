// assemble.js — `assemble-v16`. The world, as geometry, in one tile's own frame.
//
// Terrain from the seeded DEM, cut by terrainmods and roads; footprints
// extruded; forests scattered; water laid flat; the ground coloured by its own
// ground and blended by slope and height, and mottled a little from point to
// point where no orthophoto says otherwise (client/lib/terrain.js mottleAt).
// Out come four files in one tar:
//
//   scene.json   what the scene is, and where every buffer lives in mesh.bin
//   mesh.bin     positions, normals, colours and indices, one mesh per material
//   init.ply     the seed, at 30 % of the tile's budget: the same recipe
//                `train` starts brush from (client/lib/sampling.js seedOf),
//                so a dataset made of this tar and the frames is that run
//   height.r16   the ground the player walks on
//   colliders.json  the boxes the player bumps into
//
// Deterministic (Invariant 2): the world arrives ordered by id, the scatter is
// seeded from the atom, and the tar carries no timestamps.

import { fetchJson } from '../js/api.js';
import { loadAssets } from '../lib/assets.js';
import { boundsOf, placeMeshes } from '../lib/glbmesh.js';
import { packMeshes } from '../lib/mesh.js';
import { skirt } from '../lib/skirt.js';
import { encodePng } from '../lib/png.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { contains } from '../lib/poly.js';
import { toLocal } from './assemblelocal.js';
import { MATERIALS } from '../lib/props.js';
import { context, runAll } from '../lib/gen/index.js';
import { loadGround, loadMaterials, loadProducts, theGround } from './assembleload.js';
import {
    coverFeatures, coverOne, landCover, paintOf, readCover,
} from '../lib/gen/cover.js';
import { coverColour, coverPicture } from '../lib/gen/covercolour.js';
import { rngOf, seedOf } from '../lib/sampling.js';
import { writeTar } from '../lib/tar.js';
import {
    GRID, Terrain, applyHeightEdits, cutRoads, heightRaster, openHeights,
    terrainMesh,
} from '../lib/terrain.js';
import { localFromLonLat, lonLatFromLocal } from '../lib/tilemath.js';

// v4 writes each surface's own colour and leaves the light to the one
// renderer (client/lib/raster.js); v3 had baked it for a sampled baseline
// that is gone. The cut elevation is read whole (terrain.js GRID). v12 writes
// the trainer's own seed as init.ply and mottles the ground's colour. v13
// builds the ground from the cuts one zoom deeper (`dem_deeper`, geo.js
// loadDemDeeper) over a mesh twice as fine (gridFor). v14 lets that mesh
// reach 2049 across, for a z14 ground cut from z16 (db/0188). v15 carries the
// ground past the tile's edge (client/lib/skirt.js, skirtWidth). v16 takes the
// skirt's slope over eight cells and caps it, and the share from the atom's
// `skirt` param (db/0194), 0 for none.
export const ALGO = 'assemble-v16';

// How far the ground the frames draw runs past the tile's edge, as a share of
// the tile's width, so a smaller tile gets a smaller skirt. Trained splats
// are kept to the seed's box plus a metre (client/atoms/train.js keep), so
// neighbouring tiles overlap by about this much. Capped just inside CLIP_M
// (8 m), which clip() below cuts at: the structural rule allows a trained
// tile ten metres past its edge (db/0015_structural.sql), which a z14's 1 %
// would exceed.
export const SKIRT_SHARE = 0.01;
export const skirtWidth = (sw, ne, share = SKIRT_SHARE) => Math.min(
    share * Math.abs(ne.x - sw.x), CLIP_M - 0.5);

// How big the cover picture a tile carries is (FND.13). A map tile, not a
// texture: 256 is what every slippy map in the world serves.
const COVER_PX = 256;

// What assemble and sample both use to turn surfaces into splats; re-exported
// because both atoms have always reached for them here.
export { rngOf, sampleSurfaces } from '../lib/sampling.js';

// The mesh's vertices across, for the ground it was cut from: GRID's number
// at the tile's own zoom, doubled for each zoom deeper the cut is, so the
// mesh carries what the cut holds. Capped at 2049 — 8M triangles, and a
// dataset of some two hundred megabytes; 4097 would be four times that again.
export const MAX_GRID = 2049;
export const gridFor = (z, dem) =>
    Math.min(((GRID[z] ?? 65) - 1) * 2 ** (dem?.deeper ?? 0) + 1, MAX_GRID);

// ---------------------------------------------------------------- the world

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
// What a feature becomes is decided by the world's symbols, which travel with
// it (db/0161): nothing here knows what a road, a wood or a roof is. Each
// feature is put through the first symbol that matches it, and that symbol's
// layers draw it (client/lib/gen/).
function build({ z, sw, ne, dem, frame, world, random, assets, products, tile,
    ground = [], colourAt = null, coverImg = null, materials = null, skirtShare }) {
    const symbols = world.symbols ?? [];
    const feats = (world.features ?? []).map((f) => toLocal(frame, f));
    const terrain = new Terrain({ sw, ne, size: gridFor(z, dem), dem });
    // The frame's origin is the ground under the tile centre, so heights are
    // measured from there, not from the ellipsoid.
    for (let i = 0; i < terrain.h.length; i++) terrain.h[i] -= frame.h;
    terrain.datum = frame.h;
    // FND.9: what the lands here were shaped into, before anything stands on
    // it. PLAN-foundation.md §3's first step.
    applyHeightEdits(terrain, ground, (x, z0) => lonLatFromLocal(frame, { x, y: 0, z: z0 }));

    const edge = Math.hypot(ne.x - sw.x, sw.z - ne.z);
    // PLAN-foundation.md §3, step 3: the cover, after the ground is shaped and
    // before anything is drawn on it. The seed is the tile's own, so the same
    // tile wobbles the same edges in every tab (Invariant 2).
    const xOf = (u) => sw.x + (ne.x - sw.x) * u;
    const zOf = (v) => ne.z + (sw.z - ne.z) * v;
    // FND.13: where a land is, the ground is the landholder's own shapes and
    // not the operator's raster.
    const own = landCover(world, feats, { xOf, zOf,
        inLonLat: (rings, u, v) => {
            const g = lonLatFromLocal(frame, { x: xOf(u), y: 0, z: zOf(v) });
            return contains(rings, g.lon, g.lat);
        } });
    const cover = readCover(coverImg, world.cover, {
        seed: (z * 73856093) ^ Math.round(frame.lon * 1e5)
            ^ Math.round(frame.lat * 1e5),
        metres: Math.abs(ne.x - sw.x) || 1,
        blendOf: (c) => paintOf(symbols, coverOne(c))?.blend,
        owned: own.owned,
        shapes: own.shapes,
    });
    const coverFeats = coverFeatures(cover, sw, ne);
    const ctx = context({ terrain, random, radius: Math.max(6, edge / 140),
        asset: (san) => products?.get(san)?.bytes ?? null,
        product: (san) => products?.get(san)?.json ?? null,
        // The roads every `surface` layer gathered, cut into the hill before
        // anything is drawn on it.
        cut: () => cutRoads(terrain, ctx.roads) });
    // The models are placed before the ground is built: where one of them
    // opens the terrain, the terrain is not built there at all (FND.11).
    const placed = placeInstances(world.instances, assets ?? new Map(), frame);
    const drawn = runAll(symbols, [...coverFeats, ...feats], ctx);
    // The operator's orthophoto still wins where there is one (db/0106); the
    // cover answers where there is not, and the height-and-slope ramp where
    // neither reaches.
    const painted = colourAt ?? coverColour(cover, {
        paintOf: (c) => paintOf(symbols, coverOne(c)),
        material: (san) => materials?.get(san) ?? null,
        terrain, xOf, zOf,
    });
    // The mottle is for ground that has no picture of its own: an orthophoto
    // (db/0106) carries its own.
    const meshes = clip([
        skirt(terrainMesh(terrain, 'terrain', painted, placed.openings,
            { tile, mottle: !colourAt }), terrain.size, skirtWidth(sw, ne, skirtShare)),
        ...drawn.meshes, ...placed.meshes], sw, ne);
    const boxes = [...drawn.boxes, ...placed.boxes]
        .filter((b) => b.center[0] >= sw.x - CLIP_M
            && b.center[0] <= ne.x + CLIP_M && b.center[2] <= sw.z + CLIP_M
            && b.center[2] >= ne.z - CLIP_M);
    return { terrain, meshes, boxes, trees: ctx.trees, flags: drawn.flags,
        paints: ctx.paints, roads: ctx.roads, placed, cover, painted,
        openings: placed.openings };
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

    const { centre, flat, frame, sw, ne, dem, colourAt, coverImg } = await theGround(z, x, y,
        filesUrl, Boolean(world.cover?.length), atom.params.dem_deeper ?? 1);

    const assets = await loadAssets(world.instances, { filesUrl });
    const products = await loadProducts(world.symbol_files, filesUrl);
    const materials = await loadMaterials(products);
    const ground = await loadGround(world.height_edits, frame, filesUrl);
    const { terrain, meshes, boxes, trees, flags, roads, placed, openings, cover,
        painted } =
        build({ z, sw, ne, dem, frame, world, random: rngOf(atom, z, x, y),
            assets, products, ground, colourAt, coverImg, materials, tile: { z, x, y },
            skirtShare: Number(atom.params.skirt ?? SKIRT_SHARE) });
    log?.({ event: 'assembled', z, x, y, meshes: meshes.length, trees,
        cover: cover?.classes?.length ?? 0, unmapped: cover?.unmapped?.length ?? 0,
        buildings: boxes.length, roads: roads.length,
        instances: placed.meshes.length, missing: placed.missing });

    const random = rngOf(atom, z, x, y);
    const { seed: splats } = seedOf(meshes, budget, random);
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
    // FND.13: what the ground was drawn in, as a picture, for the map and for
    // QGIS. Absent where nothing mapped reaches this tile.
    const map = coverPicture(painted, COVER_PX);
    const tar = writeTar([
        { name: 'scene.json', bytes: new TextEncoder().encode(JSON.stringify(scene)) },
        { name: 'mesh.bin', bytes: bin },
        { name: 'init.ply', bytes: writePly(splats) },
        { name: 'height.r16', bytes: height.bytes },
        { name: 'colliders.json',
            bytes: new TextEncoder().encode(JSON.stringify({ boxes })) },
        ...(map ? [{ name: 'cover.png', bytes: encodePng(map, COVER_PX, COVER_PX) }] : []),
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
