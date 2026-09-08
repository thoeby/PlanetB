// assemble.js — `assemble-v1`. The world, as geometry, in one tile's own frame.
//
// Terrain from the seeded DEM, cut by terrainmods and roads; footprints
// extruded; forests scattered; water laid flat; the ortho draped over the
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

import { DEM_OFFSET, DEM_SCALE, loadDem, loadOrtho } from '../lib/geo.js';
import { packMeshes } from '../lib/mesh.js';
import { bboxOf, emptySplats, writePly } from '../lib/ply.js';
import { contains, rng } from '../lib/poly.js';
import { MATERIALS, buildings, roadMesh, trees, waterMesh } from '../lib/props.js';
import { writeTar } from '../lib/tar.js';
import {
    GRID, Terrain, applyTerrainmods, cutRoads, heightRaster, terrainMesh,
} from '../lib/terrain.js';
import { localFromLonLat, tileBbox, tileFrame } from '../lib/tilemath.js';

export const ALGO = 'assemble-v1';
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

// A road's height follows its centreline, smoothed: the ground under a road is
// not as bumpy as a 30 m DEM says it is.
function roadsOf(features, terrain) {
    const out = [];
    for (const f of features) {
        const width = Number(f.props.width) || 5;
        for (const line of f.lines) {
            if (line.length < 2) continue;
            const raw = line.map(([x, z]) => terrain.at(x, z));
            const h = raw.map((_, i) => (raw[Math.max(i - 1, 0)] + raw[i]
                + raw[Math.min(i + 1, raw.length - 1)]) / 3);
            const segments = [];
            for (let i = 0; i + 1 < line.length; i++) {
                segments.push({ a: line[i], b: line[i + 1], ha: h[i], hb: h[i + 1] });
            }
            out.push({ width, segments });
        }
    }
    return out;
}

// ---------------------------------------------------------------- sampling

const triangles = (meshes) => {
    const out = [];
    for (const m of meshes) {
        for (let i = 0; i < m.indices.length; i += 3) out.push([m, i]);
    }
    return out;
};

const vert = (m, i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
const col = (m, i) => [m.colors[i * 3], m.colors[i * 3 + 1], m.colors[i * 3 + 2]];

function area(m, i) {
    const a = vert(m, m.indices[i]);
    const b = vert(m, m.indices[i + 1]);
    const c = vert(m, m.indices[i + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]) / 2;
}

// +Y onto the surface normal, so a splat lies flat on the face it came from.
function quatToNormal(n) {
    const d = n[1];
    if (d > 0.999999) return [1, 0, 0, 0];
    if (d < -0.999999) return [0, 0, 0, 1];
    const q = [1 + d, n[2], 0, -n[0]];
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    return q.map((v) => v / len);
}

// Area-weighted, by largest remainder so the counts add up exactly and do not
// depend on the order floating point rounds in.
function allocate(tris, total) {
    const areas = tris.map(([m, i]) => area(m, i));
    const sum = areas.reduce((s, a) => s + a, 0) || 1;
    const exact = areas.map((a) => a / sum * total);
    const counts = exact.map(Math.floor);
    const left = total - counts.reduce((s, c) => s + c, 0);
    const order = exact.map((e, i) => [e - Math.floor(e), i])
        .sort((p, q) => q[0] - p[0] || p[1] - q[1]);
    for (let k = 0; k < left; k++) counts[order[k % order.length][1]] += 1;
    return { counts, sum };
}

function sampleSurfaces(meshes, total, random) {
    const tris = triangles(meshes);
    const { counts, sum } = allocate(tris, total);
    const f = emptySplats(total);
    const spacing = Math.sqrt(sum / Math.max(total, 1));
    let k = 0;
    for (let t = 0; t < tris.length; t++) {
        const [m, i] = tris[t];
        const ia = m.indices[i];
        const ib = m.indices[i + 1];
        const ic = m.indices[i + 2];
        const n = [m.normals[ia * 3], m.normals[ia * 3 + 1], m.normals[ia * 3 + 2]];
        const q = quatToNormal(n);
        for (let s = 0; s < counts[t]; s++, k++) {
            let u = random();
            let v = random();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = [1 - u - v, u, v];
            for (const [j, get] of [[0, vert], [1, col]]) {
                const p = [0, 0, 0];
                for (let c = 0; c < 3; c++) {
                    const val = get(m, [ia, ib, ic][c]);
                    p[0] += val[0] * w[c]; p[1] += val[1] * w[c]; p[2] += val[2] * w[c];
                }
                if (j === 0) { f.x[k] = p[0]; f.y[k] = p[1]; f.z[k] = p[2]; } else {
                    f.r[k] = p[0]; f.g[k] = p[1]; f.b[k] = p[2];
                }
            }
            f.a[k] = 1;
            f.sx[k] = spacing * 0.7;
            f.sy[k] = spacing * 0.15;
            f.sz[k] = spacing * 0.7;
            [f.qw[k], f.qx[k], f.qy[k], f.qz[k]] = q;
        }
    }
    return f;
}

const rngOf = (atom, z, x, y) => rng((atom.seed ?? 0) + z * 1000003 + x * 1009 + y);

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

// The scene itself: ground first, then everything that stands on it.
function build({ z, sw, ne, dem, ortho, frame, world, random }) {
    const feats = (world.features ?? []).map((f) => toLocal(frame, f));
    const by = (kind) => feats.filter((f) => f.kind === kind);
    const terrain = new Terrain({ sw, ne, size: GRID[z] ?? 65, dem });
    // The frame's origin is the ground under the tile centre, so heights are
    // measured from there, not from the ellipsoid.
    for (let i = 0; i < terrain.h.length; i++) terrain.h[i] -= frame.h;
    applyTerrainmods(terrain, by('terrainmod'));
    const roads = roadsOf(by('road'), terrain);
    cutRoads(terrain, roads);

    const edge = Math.hypot(ne.x - sw.x, sw.z - ne.z);
    const built = buildings(by('footprint'), terrain);
    const wood = trees(by('forest'), terrain, random, Math.max(6, edge / 140));
    const meshes = clip([terrainMesh(terrain, ortho), roadMesh(roads, terrain),
        built.walls, built.roofs, waterMesh(by('water'), terrain),
        wood.trunks, wood.canopies], sw, ne);
    built.boxes = built.boxes.filter((b) => b.center[0] >= sw.x - CLIP_M
        && b.center[0] <= ne.x + CLIP_M && b.center[2] <= sw.z + CLIP_M
        && b.center[2] >= ne.z - CLIP_M);
    return { terrain, meshes, built, wood, roads };
}

// -------------------------------------------------------------------- atom

export async function run({ atom, canvas, log, apiUrl, filesUrl }) {
    const { z, x, y, budget } = atom.params;
    const world = await fetch(`${apiUrl}/rpc/tile_world`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ z, x, y }),
    }).then((r) => r.json());
    // Invariant 2: this atom was built from one snapshot of the world. If the
    // world has moved, the job is already cancelled and this work is waste.
    if (atom.inputs?.snapshot && world.snapshot !== atom.inputs.snapshot) {
        throw new Error(`the world moved: ${world.snapshot} is not ${atom.inputs.snapshot}`);
    }

    const dem = await loadDem(z, x, y, { filesUrl });
    if (!dem) throw new Error(`no dem covers ${z}/${x}/${y} — seed it (infra/seed)`);
    const ortho = await loadOrtho(z, x, y, { filesUrl, canvas }).catch(() => null);

    const b = tileBbox(z, x, y);
    const centre = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
    const flat = tileFrame(z, x, y, 0);
    const frame = tileFrame(z, x, y, sampleGround(dem));
    const sw = localFromLonLat(frame, b.west, b.south);
    const ne = localFromLonLat(frame, b.east, b.north);

    const { terrain, meshes, built, wood, roads } =
        build({ z, sw, ne, dem, ortho, frame, world, random: rngOf(atom, z, x, y) });
    log?.({ event: 'assembled', z, x, y, meshes: meshes.length, trees: wood.count,
        buildings: built.boxes.length, roads: roads.length });

    const random = rngOf(atom, z, x, y);
    const splats = sampleSurfaces(meshes, Math.round(budget * INIT_SHARE), random);
    const height = heightRaster(terrain);
    const { bin, specs } = packMeshes(meshes);
    const scene = {
        algo: ALGO, tile: { z, x, y }, origin: { ...centre, h: frame.h },
        budget, materials: MATERIALS, meshes: specs, height: height.meta,
        instances: world.instances ?? [], snapshot: world.snapshot,
        counts: { trees: wood.count, buildings: built.boxes.length, splats: splats.count },
        // The frame at ground level; the flat one is what tilemath gives for h=0.
        frame: { lon: frame.lon, lat: frame.lat, h: frame.h, flat_h: flat.h },
    };
    const tar = writeTar([
        { name: 'scene.json', bytes: new TextEncoder().encode(JSON.stringify(scene)) },
        { name: 'mesh.bin', bytes: bin },
        { name: 'init.ply', bytes: writePly(splats) },
        { name: 'height.r16', bytes: height.bytes },
        { name: 'colliders.json',
            bytes: new TextEncoder().encode(JSON.stringify({ boxes: built.boxes })) },
    ]);
    return {
        files: [{ ext: 'tar', kind: 'init_ply', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, splat_count: splats.count, finite: true,
            bbox: bboxOf(splats),
            trees: wood.count, buildings: built.boxes.length, snapshot: world.snapshot,
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
    return dem.data[j * n + i] * DEM_SCALE + DEM_OFFSET;
};
