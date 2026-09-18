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
// 12 M splats is what a mid-range card sorts and draws at 60 fps; 25 M was
// what the engine would accept, not what it could show.
// `splatBudget` is what the engine draws, not what this holds: a tile that
// does not fit is drawn at a coarser level rather than left out
// (client/lib/lodorder.js, client/atoms/sog.js). `tiles` is the memory cap.
export const LIMITS = { tiles: 64, splatBudget: 12e6, inflight: 4 };
// Without WebGPU the engine sorts every loaded splat on the CPU each time the
// camera turns and ships the order back as a texture; past a few million that
// is the stutter, not the draw. Under WebGL2 the world is kept a third the
// size and tiles are taken two at a time (client/play.html).
export const WEBGL_LIMITS = { tiles: 48, splatBudget: 4e6, inflight: 2 };

// How long a tile that has left the view is kept before it is thrown away.
// Panning is turning your head and turning it back, and a tile dropped the
// moment it leaves the frustum is a tile fetched again a second later — the
// world breaking up around somebody who is only looking round.
export const KEEP_MS = 20000;
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

// The traversal visits hundreds of tiles a pass; a tile's radius never changes
// and its centre only when the anchor or what it shows does, so both are kept
// by key. The anchor object is replaced on every rebase (origin.js), which is
// what tells a cached centre it is stale.
const geometry = new Map();

function geometryOf(k, z, x, y, shown, origin) {
    let g = geometry.get(k);
    if (!g) {
        g = { radius: tileRadius(z, x, y), anchor: null, sha: null, centre: null };
        geometry.set(k, g);
    }
    if (g.anchor !== origin.anchor || g.sha !== shown.sha) {
        g.anchor = origin.anchor;
        g.sha = shown.sha;
        g.centre = origin.localOf(shown.manifest.origin);
    }
    return g;
}

class Candidate {
    constructor(z, x, y, row, origin, candidates) {
        this.z = z; this.x = x; this.y = y;
        this.key = key(z, x, y);
        this.row = row;
        // Where the tile is comes from the manifest of whatever is being shown:
        // a candidate carries its own (T7).
        this.shown = showing(row, candidates);
        const g = geometryOf(this.key, z, x, y, this.shown, origin);
        this.radius = g.radius;
        this.centre = g.centre;
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

// A tile refines into the children that are published. A child with no
// `tile` row at all lies outside any compiled area and is not a hole; a child
// that exists and is unpublished is one — and rather than wait for every one
// of sixteen to be published before any is drawn, the parent stays under the
// ones that are. `whole` says whether it may go. That is why the streamer is
// given every tile row, not only the published ones.
function refinableInto(world, c) {
    const rows = tm.children(c.z, c.x, c.y)
        .map((t) => ({ t, row: world.tiles.get(key(t.z, t.x, t.y)) }))
        .filter((e) => e.row);
    const ready = rows.filter((e) => published(e.row, world)
        && loadable(world, key(e.t.z, e.t.x, e.t.y)));
    if (!ready.length) return null;
    return {
        whole: ready.length === rows.length,
        kids: ready.map((e) => new Candidate(e.t.z, e.t.x, e.t.y, e.row, world.origin,
            world.candidates)),
    };
}

// Walks z6 downwards, collecting the tiles that should be on screen.
function traverse(world, camera) {
    const out = [];
    const stack = world.roots.map((t) => candidate(world, t)).filter(Boolean);
    while (stack.length) {
        const c = stack.pop();
        if (!sphereVisible(c.centre, c.radius, camera.planes)) continue;
        c.sse = screenSpaceError(c, c.centre, camera);
        const into = refinableInto(world, c);
        const kids = into?.kids;
        // Already refined: keep it refined until the error is comfortably under
        // the threshold, not merely under it.
        const isRefined = !world.loaded.has(c.key)
            && kids?.some((k) => world.loaded.has(k.key));
        const threshold = isRefined ? REFINE_PX / HYSTERESIS : REFINE_PX;
        if (kids && c.sse > threshold) {
            stack.push(...kids);
            if (!into.whole) out.push(c);
        } else {
            out.push(c);
        }
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

// Nearest first, up to the number of tiles this machine will hold.
//
// This used to cap the splats too, and skip a tile that did not fit — which is
// why the ground at the edge of the view went missing rather than going
// coarse. A tile now carries its own levels and the engine spends one budget
// across all of them (client/js/tiles.js fileOf, play.html splatBudget), so
// how much of a tile to draw is the engine's question and it can answer it for
// every tile at once. What is left here is memory: each tile is an asset, an
// entity and a placement, and that is what `tiles` bounds.
function applyTileCap(ordered, limits) {
    return ordered.slice(0, limits.tiles);
}

// One tile covers the other's ground: the same tile, an ancestor or a descendant.
function overlaps(a, b) {
    const [hi, lo] = a.z <= b.z ? [a, b] : [b, a];
    const f = 2 ** (lo.z - hi.z);
    return Math.floor(lo.x / f) === hi.x && Math.floor(lo.y / f) === hi.y;
}

// A tile on its way out stays until every tile taking its place is drawing:
// no frame with a hole. It asks `resident` and not `entity`, because having an
// entity is not the same as having splats in it — an entity is made when the
// bytes arrive, and a tile that is more than one file has an entity before it
// has anything to show (client/js/tiles.js, PLAN-lod.md).
function replaced(world, keep, k) {
    const t = parseKey(k);
    return keep.filter((c) => overlaps(t, c))
        .every((c) => world.loaded.get(c.key)?.resident === true);
}

// world: { tiles: Map(key -> row), roots: [{z,x,y}], origin, loaded: Map(key ->
// {usedAt, entity?, resident?}), inflight: number, failed?: Map(key -> retryAt),
// now? }.
// camera: { position, planes, screenH, fovY }.
export function selectTiles(world, camera, limits = LIMITS) {
    const ordered = prioritise(world, camera, traverse(world, camera));
    const keep = applyTileCap(ordered, limits);
    const want = new Set(keep.map((c) => c.key));

    const load = [];
    const room = Math.max(0, limits.inflight - (world.inflight ?? 0));
    for (const c of keep) {
        if (!world.loaded.has(c.key) && load.length < room) load.push(c);
    }
    // Kept for a while after it leaves the view — unless there are more tiles
    // loaded than the cap allows, in which case the least recently used go now.
    const crowded = world.loaded.size > limits.tiles;
    const keepMs = limits.keepMs ?? KEEP_MS;
    const cold = (k) => crowded
        || (world.now ?? 0) - (world.loaded.get(k).seenAt ?? 0) >= keepMs;
    const unload = [...world.loaded.keys()]
        .filter((k) => !want.has(k) && cold(k) && replaced(world, keep, k))
        .sort((a, b) => (world.loaded.get(a).usedAt - world.loaded.get(b).usedAt));
    return { want, load, unload };
}

