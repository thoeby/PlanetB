// blueprint.js — the ground as white clay, for shaping it and drawing on it
// (PLAN-editors.md D2, §2.1; EDT.1).
//
// A mode of the world view, not a page: Shape and Lines open it with a land
// chosen and close it when they close. While it is open the splats and the
// placed models over the region are put away (client/js/tiles.js hideUnder)
// and the ground is a mesh of the land's own grid — the DEM plus the land's
// shaping, lit from the north-west and tinted by slope (client/lib/clay.js),
// with a coarser dimmed ring a kilometre around it and the z14 ground mesh
// (client/js/ground.js) beyond that.
//
// It draws; it writes nothing. What the ground is shaped into is
// client/js/sculpt.js's grid and nothing here changes it.

import { CHUNK, chunkGeometry, chunksIn, chunksOf, geodetic, heightIn, indexOf, latAt,
    layout, local, lonAt } from '../lib/bpgrid.js';
import { linear, litBy, vertexColour } from '../lib/clay.js';
import { drawChunkLines, remembered } from './bpoverlay.js';
import { buildRing, grow, z14Keys } from './bpring.js';
import * as tm from '../lib/tilemath.js';

// How far past the land the dimmed ring reaches.
export const MARGIN_M = 1000;
// How far the world's ground under the ring is sunk, and how far inside the
// ring's edge that starts, so the slope down is under the ring too.
const SINK_M = 400;
const SINK_INSET_M = 200;
// Solid's light: level ground a light grey, and every few degrees of slope a
// clear step lighter towards the sun or darker away from it — the plain clay's
// light is nearly overhead, and an eight-metre pit in it was hard to see.
const FLAT_LIT = litBy(0, 1, 0);
const hard = (lit) => Math.min(1, Math.max(0.12, 0.8 + 3.2 * (lit - FLAT_LIT)));

// How long the page waits for the elevation under the region to arrive.
const DEM_WAIT_MS = 20000;

// The overlays the box switches (client/js/bpoverlay.js); colour needs two.
export const OVERLAYS = { view: 'solid', contours: false, changed: false, grid: false,
    flat: false, relief: true, steep: false, neighbours: true, steepAt: 35 };

export class Blueprint {
    constructor(app, pc, { origin, floor, streamer, groundMesh = null, preview = null }) {
        Object.assign(this, { app, pc, origin, floor, streamer, groundMesh, preview });
        this.active = false;
        this.overlays = remembered(OVERLAYS);
        this.chunks = new Map();
        this.listeners = new Set();
    }

    // What the ground is, in metres above the sea, where the elevation says.
    demAt(lon, lat) { return this.floor?.heightAt(lon, lat) ?? null; }

    // What the ground is being shaped into, where the land is; the elevation
    // everywhere else.
    heightAt(lon, lat) {
        const L = this.L;
        if (L) {
            const { i, j } = indexOf(L, lon, lat);
            if (i >= 0 && j >= 0 && i <= L.cols - 1 && j <= L.rows - 1) {
                return heightIn(L, this.heights, i, j);
            }
        }
        const d = this.demAt(lon, lat);
        return d === null ? null : d + (this.shaping?.at(lon, lat) ?? 0);
    }

    // Everything drawn over this ground (overlays, ribbons) redraws when it
    // changes; a listener hears the rectangle that did.
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    async open(area, shaping) {
        const started = performance.now();
        if (this.active) this.close();
        this.area = area;
        this.shaping = shaping;
        const b = area.bbox;
        const box = [b.west, b.south, b.east, b.north];
        const outer = grow(box, MARGIN_M);
        this.onStep?.('Fetching the elevation…');
        await this.demReady(outer);
        // Said, and drawn, before the clay is built: building it holds the tab.
        this.onStep?.('Building the clay…');
        if (this.onStep) await new Promise((done) => requestAnimationFrame(() => done()));
        this.L = layout(box, shaping?.grid?.cell ?? 1);
        this.h0 = this.demAt(this.L.lon0, this.L.lat0) ?? 0;
        this.frame = { lon: this.L.lon0, lat: this.L.lat0, h: this.h0 };
        this.sample();
        this.root = new this.pc.Entity('blueprint');
        this.app.root.addChild(this.root);
        this.place();
        for (const c of chunksOf(this.L)) this.buildChunk(c);
        this.ring(outer, box);
        this.hideWorld(outer);
        // The sky's haze is for looking across a valley; over a model of one
        // it only greys out the ring around the land.
        this.fogWas = this.app.scene.fog?.density;
        if (this.fogWas) this.app.scene.fog.density = this.fogWas / 8;
        this.active = true;
        this.openedMs = performance.now() - started;
        this.tell(null);
        return this.openedMs;
    }

    close() {
        if (!this.active) return;
        this.root?.destroy();
        this.root = null;
        this.chunks.clear();
        this.streamer?.hideUnder([]);
        this.streamer?.hideEverything?.(false);
        this.preview?.setVisible(true);
        this.groundMesh?.reshape(null, []);
        if (this.fogWas) this.app.scene.fog.density = this.fogWas;
        this.active = false;
        this.L = null;
        this.tell(null);
    }

    // The elevation under every z14 tile of the region, fetched before the
    // first vertex is laid: a mesh built from half-arrived rasters is a land
    // with pits in it.
    async demReady(box) {
        if (!this.floor) return;
        const keys = z14Keys(box);
        const until = Date.now() + DEM_WAIT_MS;
        while (Date.now() < until) {
            const missing = keys.filter(([x, y]) => this.floor.raster(14, x, y) === undefined);
            if (!missing.length) return;
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    // Base heights (the elevation), the shaping over them, and which vertices
    // are this land's. The first is read once; the other two per rebuild.
    sample() {
        const L = this.L;
        const n = L.cols * L.rows;
        this.base = new Float32Array(n);
        this.delta = new Float32Array(n);
        this.unsaved = new Uint8Array(n);
        this.inside = new Uint8Array(n);
        this.heights = new Float32Array(n);
        for (let j = 0; j < L.rows; j++) {
            for (let i = 0; i < L.cols; i++) {
                const k = j * L.cols + i;
                const lon = lonAt(L, i);
                const lat = latAt(L, j);
                this.base[k] = this.demAt(lon, lat) ?? this.h0;
                this.inside[k] = this.shaping?.inside(lon, lat) ? 1 : 0;
            }
        }
        this.resample(0, 0, L.cols - 1, L.rows - 1);
    }

    resample(i0, j0, i1, j1) {
        const L = this.L;
        const s = this.shaping;
        for (let j = Math.max(0, j0); j <= Math.min(L.rows - 1, j1); j++) {
            for (let i = Math.max(0, i0); i <= Math.min(L.cols - 1, i1); i++) {
                const k = j * L.cols + i;
                const lon = lonAt(L, i);
                const lat = latAt(L, j);
                const d = s ? s.at(lon, lat) : 0;
                this.delta[k] = d;
                this.unsaved[k] = s?.savedAt && Math.abs(d - s.savedAt(lon, lat)) > 0.005 ? 1 : 0;
                this.heights[k] = this.base[k] + d;
            }
        }
    }

    // The land changed under [w, s, e, n] (or all of it, for null): only the
    // chunks that rectangle touches are built again.
    // `quick`: a stroke is on, and the contours of what it touched are drawn
    // once it is let go of (settle), not sixty times a second while it moves.
    rebuild(rect = null, { quick = false } = {}) {
        if (!this.active) return 0;
        this.quick = quick;
        const started = performance.now();
        const L = this.L;
        let [i0, j0, i1, j1] = [0, 0, L.cols - 1, L.rows - 1];
        if (rect) {
            const a = indexOf(L, rect[0], rect[3]);
            const b = indexOf(L, rect[2], rect[1]);
            // One vertex more each way: a normal reads its neighbours.
            [i0, j0, i1, j1] = [Math.floor(a.i) - 1, Math.floor(a.j) - 1,
                Math.ceil(b.i) + 1, Math.ceil(b.j) + 1];
        }
        this.resample(i0, j0, i1, j1);
        for (const c of chunksIn(chunksOf(L), i0 - 1, j0 - 1, i1 + 1, j1 + 1)) this.buildChunk(c);
        this.tell(rect);
        this.rebuiltMs = performance.now() - started;
        return this.rebuiltMs;
    }

    // Every overlay setting that is colour means every chunk is repainted.
    repaint() { if (this.active) this.rebuild(null); }

    colourOf() {
        const o = this.overlays;
        // Contours view: flat clay, so the lines are what is read. Solid: a
        // harder light than the plain half-lit clay, so a raised bank or a dug
        // pit reads as shape without any colour.
        const shade = (lit) => (o.flat ? 0.92 : o.relief ? hard(lit) : lit);
        return (k, i, j, slope, lit) => linear(vertexColour({ slope, lit: shade(lit), i, j,
            inside: this.inside[k] === 1, delta: this.delta[k], unsaved: this.unsaved[k] === 1,
            changed: o.changed, steep: o.steep ? o.steepAt : 0 }));
    }

    buildChunk(c) {
        const geo = chunkGeometry(this.L, this.heights, c, this.colourOf(),
            { h0: this.h0, skirt: 2 });
        const had = this.chunks.get(c.key);
        const mesh = had?.mesh ?? new this.pc.Mesh(this.app.graphicsDevice);
        mesh.setPositions(geo.positions);
        mesh.setNormals(geo.normals);
        mesh.setColors(geo.colors, 3);
        mesh.setIndices(geo.indices);
        mesh.update(this.pc.PRIMITIVE_TRIANGLES);
        const one = had ?? { chunk: c, mesh,
            entity: this.meshEntity(`blueprint ${c.key}`, mesh) };
        this.chunks.set(c.key, one);
        if (this.quick) one.stale = true;
        else drawChunkLines(this, one);
        return one;
    }

    // The stroke was let go of: the contours of every chunk it touched.
    settle() {
        this.quick = false;
        for (const one of this.chunks.values()) {
            if (!one.stale) continue;
            one.stale = false;
            drawChunkLines(this, one);
        }
    }

    // The contours or the grid were switched: every chunk's lines again.
    relines() {
        if (!this.active) return;
        for (const one of this.chunks.values()) drawChunkLines(this, one);
    }

    meshEntity(name, mesh, parent = this.root) {
        const entity = new this.pc.Entity(name);
        entity.addComponent('render', {
            meshInstances: [new this.pc.MeshInstance(mesh, this.material())],
            castShadows: false, receiveShadows: false,
        });
        parent.addChild(entity);
        return entity;
    }

    material() {
        if (this.mat) return this.mat;
        const { pc } = this;
        const m = new pc.StandardMaterial();
        m.useLighting = false;
        m.diffuse = new pc.Color(0, 0, 0);
        m.emissive = new pc.Color(1, 1, 1);
        m.emissiveVertexColor = true;
        m.cull = pc.CULLFACE_NONE;
        m.update();
        this.mat = m;
        return m;
    }

    ring(outer, box) { this.ringEntity = buildRing(this, outer, box); }

    // The splats and the placed models over the region go; the z14 ground
    // beyond the ring is drawn as dimmed clay instead of grass.
    hideWorld(box) {
        const keys = z14Keys(box).map(([x, y]) => `${x}/${y}`);
        this.streamer?.hideUnder(keys.map((k) => `14/${k}`));
        this.streamer?.hideEverything?.(true);
        this.preview?.setVisible(false);
        // Under the clay and its ring the world's own ground goes well down:
        // three metres under was shallower than a player may dig, and it came
        // up through the hole as dark blobs (the operator's note).
        const under = grow(box, -SINK_INSET_M);
        const sink = (lon, lat) => (lon > under[0] && lon < under[2] && lat > under[1]
            && lat < under[3] ? -SINK_M : 0);
        this.groundMesh?.reshape(sink, keys, { clay: true });
    }

    // Hold Tab: the splats and the models come back over the clay for as long
    // as it is held (PLAN-editors.md idea 5).
    peek(on) {
        if (!this.active) return;
        this.peeking = on;
        this.streamer?.hideUnder(on ? [] : z14Keys(grow(this.L.bbox, MARGIN_M))
            .map(([x, y]) => `14/${x}/${y}`));
        this.streamer?.hideEverything?.(!on);
        this.preview?.setVisible(on);
        // Blended only while peeking: a blended mesh is drawn in the
        // transparent pass, sorted and without writing depth.
        const m = this.material();
        m.blendType = on ? this.pc.BLEND_NORMAL : this.pc.BLEND_NONE;
        m.opacity = on ? 0.25 : 1;
        m.update();
    }

    // The region's frame, in the scene's floating one.
    place() {
        if (!this.root) return;
        const p = this.origin.localOf(this.frame);
        this.root.setLocalPosition(p.x, p.y, p.z);
        const q = tm.matrixToQuaternion(tm.enuRotation(this.frame, this.origin.anchor));
        this.root.setLocalRotation(q[0], q[1], q[2], q[3]);
    }

    rebased() { this.place(); }

    // A scene point (the floating origin's frame) as degrees and metres.
    toGeo(p) {
        const inv = this.root.getWorldTransform().clone().invert();
        const v = inv.transformPoint(new this.pc.Vec3(p.x, p.y, p.z));
        return geodetic(this.L, v, this.h0);
    }

    // And back: where a point on the ground is in the scene.
    toScene(lon, lat, h) {
        const v = local(this.L, lon, lat, h, this.h0);
        return this.root.getWorldTransform().transformPoint(new this.pc.Vec3(v.x, v.y, v.z));
    }

    tell(rect) { for (const fn of this.listeners) fn(rect); }
}

// The ray from the camera through a pixel, marched over the clay and then
// bisected: where the pointer is on the ground, or null. The ray is taken into
// the region's own frame once, so each step is arithmetic and not a matrix.
export function pickGround(bp, camera, sx, sy, { far = 6000, step = 4 } = {}) {
    if (!bp.active) return null;
    const cam = camera.camera;
    const inv = bp.root.getWorldTransform().clone().invert();
    const a = inv.transformPoint(cam.screenToWorld(sx, sy, cam.nearClip));
    const b = inv.transformPoint(cam.screenToWorld(sx, sy, Math.min(cam.farClip, far)));
    const dir = b.clone().sub(a);
    const len = dir.length();
    dir.normalize();
    const at = (t) => ({ x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t });
    const above = (t) => {
        const g = geodetic(bp.L, at(t), bp.h0);
        const h = bp.heightAt(g.lon, g.lat);
        return h === null ? null : g.h - h;
    };
    let t0 = 0;
    let was = above(0);
    for (let t = step; t <= len; t += step * (1 + t / 800)) {
        const now = above(t);
        if (now !== null && was !== null && now <= 0 && was > 0) {
            let lo = t0;
            let hi = t;
            for (let k = 0; k < 24; k++) {
                const mid = (lo + hi) / 2;
                if ((above(mid) ?? 1) > 0) lo = mid; else hi = mid;
            }
            const g = geodetic(bp.L, at(hi), bp.h0);
            return { lon: g.lon, lat: g.lat, h: bp.heightAt(g.lon, g.lat) };
        }
        t0 = t;
        was = now;
    }
    return null;
}

export { CHUNK, grow, z14Keys };
