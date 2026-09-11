// traverse.js — which tiles should be on screen.
//
// A pure function of (what the world publishes, where the camera is, what is
// loaded). No engine, no network, nothing to dispose — which is why
// client/test/tiles.test.js can fly a scripted path through it under node.
//
// Split out of tiles.js when that file outgrew four hundred lines; the streamer
// that owns the entities is still there.


import * as tm from '../lib/tilemath.js';

export const REFINE_PX = 2;
// Coarsening uses a lower threshold than refining, so a camera hovering at the
// boundary does not load and unload the same level every frame.
export const HYSTERESIS = 1.4;
export const LIMITS = { tiles: 40, splats: 25e6, inflight: 4 };
// How often a loaded tile is re-checked for a newer published version.
export const POLL_MS = 30000;
// How long a tile that failed to load is left alone before it is tried again.
export const RETRY_MS = 30000;

export const key = (z, x, y) => `${z}/${x}/${y}`;
export const parseKey = (k) => {
    const [z, x, y] = k.split('/').map(Number);
    return { z, x, y };
};

// Half the diagonal of the tile on the ground, plus room for terrain relief.
// Used as a bounding sphere for culling and for the distance the error uses.
export function tileRadius(z, x, y) {
    const b = tm.tileBbox(z, x, y);
    const o = tm.tileFrame(z, x, y, 0);
    const w = tm.localFromLonLat(o, b.east, o.lat).x - tm.localFromLonLat(o, b.west, o.lat).x;
    const h = tm.localFromLonLat(o, o.lon, b.north).z - tm.localFromLonLat(o, o.lon, b.south).z;
    return Math.hypot(w, h) / 2 * 1.1;
}

// sse = geometric_error_m * screenH / (2 * dist * tan(fov/2)), with dist taken
// to the bounding sphere rather than its centre so a tile the camera is sitting
// inside does not report an infinite error.
export function screenSpaceError(tile, centre, camera) {
    const d = Math.max(1, Math.hypot(
        camera.position.x - centre.x,
        camera.position.y - centre.y,
        camera.position.z - centre.z) - tile.radius);
    const err = tile.row.manifest?.geometric_error_m ?? tile.radius / 32;
    return err * camera.screenH / (2 * d * Math.tan(camera.fovY / 2));
}

// Planes are [a, b, c, d] with inward normals; a sphere is out if it is fully
// behind any one of them.
export function sphereVisible(centre, radius, planes) {
    if (!planes) return true;
    for (const [a, b, c, d] of planes) {
        if (a * centre.x + b * centre.y + c * centre.z + d < -radius) return false;
    }
    return true;
}

// What a tile shows. Normally what has been approved; with candidates on — the
// switch an owner or an approver has (T7) — whatever was rendered last, so they
// can look at it in place before saying yes.
export const showing = (row, candidates) => (candidates && row?.candidate_sha256
    ? { sha: row.candidate_sha256, manifest: row.candidate_manifest, candidate: true }
    : row?.published_version > 0 && row.sog_sha256
        ? { sha: row.sog_sha256, manifest: row.manifest, candidate: false }
        : null);

const published = (row, world) => Boolean(showing(row, world?.candidates));

class Candidate {
    constructor(z, x, y, row, origin, candidates) {
        this.z = z; this.x = x; this.y = y;
        this.key = key(z, x, y);
        this.row = row;
        this.radius = tileRadius(z, x, y);
        // Where the tile is comes from the manifest of whatever is being shown:
        // a candidate carries its own (T7).
        this.shown = showing(row, candidates);
        this.centre = origin.localOf(this.shown.manifest.origin);
    }
}

// A tile whose load failed is left alone until its retry time; until then it
// is treated as unpublished, so its parent stays whole.
const loadable = (world, k) => !((world.failed?.get(k) ?? 0) > (world.now ?? 0));

function candidate(world, t) {
    const k = key(t.z, t.x, t.y);
    const row = world.tiles.get(k);
    const seen = showing(row, world.candidates);
    if (!seen || !seen.manifest?.origin || !loadable(world, k)) return null;
    return new Candidate(t.z, t.x, t.y, row, world.origin, world.candidates);
}

// A tile refines only when every child the world says exists is published: a
// child with no `tile` row at all lies outside any compiled area and is not a
// hole, while a child that exists and is unpublished is one, and refining into
// it would tear the ground open. That is why the streamer is given every tile
// row, not only the published ones.
function refinableInto(world, c) {
    const rows = tm.children(c.z, c.x, c.y)
        .map((t) => ({ t, row: world.tiles.get(key(t.z, t.x, t.y)) }))
        .filter((e) => e.row);
    if (!rows.length || !rows.every((e) => published(e.row, world))) return null;
    if (!rows.every((e) => loadable(world, key(e.t.z, e.t.x, e.t.y)))) return null;
    return rows.map((e) => new Candidate(e.t.z, e.t.x, e.t.y, e.row, world.origin,
        world.candidates));
}

// Walks z6 downwards, collecting the tiles that should be on screen.
function traverse(world, camera) {
    const out = [];
    const stack = world.roots.map((t) => candidate(world, t)).filter(Boolean);
    while (stack.length) {
        const c = stack.pop();
        if (!sphereVisible(c.centre, c.radius, camera.planes)) continue;
        c.sse = screenSpaceError(c, c.centre, camera);
        const kids = refinableInto(world, c);
        // Already refined: keep it refined until the error is comfortably under
        // the threshold, not merely under it.
        const isRefined = !world.loaded.has(c.key)
            && kids?.some((k) => world.loaded.has(k.key));
        const threshold = isRefined ? REFINE_PX / HYSTERESIS : REFINE_PX;
        if (kids && c.sse > threshold) stack.push(...kids);
        else out.push(c);
    }
    return out;
}

// Nearest first, then least recently used: the two orders agree on what to drop
// when the caps bite, and the tie-break is what makes the eviction LRU.
function prioritise(world, camera, wanted) {
    return wanted.map((c) => ({
        c,
        d: Math.hypot(camera.position.x - c.centre.x,
            camera.position.y - c.centre.y,
            camera.position.z - c.centre.z),
        used: world.loaded.get(c.key)?.usedAt ?? 0,
    })).sort((a, b) => (a.d - b.d) || (b.used - a.used)).map((e) => e.c);
}

function applyCaps(ordered, limits) {
    const keep = [];
    let splats = 0;
    for (const c of ordered) {
        const n = c.row.manifest?.splats ?? 0;
        if (keep.length >= limits.tiles || splats + n > limits.splats) break;
        keep.push(c);
        splats += n;
    }
    return { keep, splats };
}

// One tile covers the other's ground: the same tile, an ancestor or a descendant.
function overlaps(a, b) {
    const [hi, lo] = a.z <= b.z ? [a, b] : [b, a];
    const f = 2 ** (lo.z - hi.z);
    return Math.floor(lo.x / f) === hi.x && Math.floor(lo.y / f) === hi.y;
}

// A tile on its way out stays until every tile taking its place is in the
// scene (an entry with `entity: null` is still loading): no frame with a hole.
function replaced(world, keep, k) {
    const t = parseKey(k);
    return keep.filter((c) => overlaps(t, c))
        .every((c) => world.loaded.has(c.key) && world.loaded.get(c.key).entity !== null);
}

// world: { tiles: Map(key -> row), roots: [{z,x,y}], origin, loaded: Map(key ->
// {usedAt, entity?}), inflight: number, failed?: Map(key -> retryAt), now? }.
// camera: { position, planes, screenH, fovY }.
export function selectTiles(world, camera, limits = LIMITS) {
    const ordered = prioritise(world, camera, traverse(world, camera));
    const { keep, splats } = applyCaps(ordered, limits);
    const want = new Set(keep.map((c) => c.key));

    const load = [];
    const room = Math.max(0, limits.inflight - (world.inflight ?? 0));
    for (const c of keep) {
        if (!world.loaded.has(c.key) && load.length < room) load.push(c);
    }
    const unload = [...world.loaded.keys()]
        .filter((k) => !want.has(k) && replaced(world, keep, k))
        .sort((a, b) => (world.loaded.get(a).usedAt - world.loaded.get(b).usedAt));
    return { want, load, unload, splats };
}

