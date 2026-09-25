// brushdisc.js — the brush, drawn on the clay as what it will do: a disc (or
// a square) lying on the ground at its size, shaded by its falloff — solid
// where it is at full strength, fading to nothing at its edge — with its rim
// and its core drawn as rings over it. A thin ring alone said how big a brush
// was and nothing about how it would push (the operator's note on EDT.7).
//
// One mesh, rebuilt where the pointer is each frame: a few hundred vertices,
// every one lifted to the clay under it. It multiplies the clay rather than
// lying over it: white where the brush does nothing, the tone where it is
// strongest, so the clay's own shading and contours still read through.

import { falloffAt } from './sculptbrush.js';
import { linear } from '../lib/clay.js';
import { local } from '../lib/bpgrid.js';

const RINGS = 14;
const AROUND = 48;
// How far off the clay the disc floats, so it is not buried in it.
const LIFT_M = 0.2;
// How much of the tone the disc takes where the brush is at full strength.
const MOST = 0.7;

export class BrushDisc {
    constructor(bp) {
        this.bp = bp;
        this.entity = null;
        this.mesh = null;
    }

    material() {
        if (this.mat) return this.mat;
        const { pc } = this.bp;
        const m = new pc.StandardMaterial();
        m.useLighting = false;
        m.diffuse = new pc.Color(0, 0, 0);
        m.emissive = new pc.Color(1, 1, 1);
        m.emissiveVertexColor = true;
        m.blendType = pc.BLEND_MULTIPLICATIVE;
        m.depthWrite = false;
        m.cull = pc.CULLFACE_NONE;
        m.update();
        this.mat = m;
        return m;
    }

    hide() { if (this.entity) this.entity.enabled = false; }

    /**
     * At `at` {lon, lat}, `radius` metres, shaded by `how` {soft, curve,
     * square}, in `tone` [r, g, b] (0–1, as seen).
     */
    show(at, radius, how, tone) {
        const bp = this.bp;
        if (!bp.active || !at) { this.hide(); return; }
        const { pc } = bp;
        const n = (RINGS + 1) * AROUND;
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        const c = linear(tone);
        const mLon = 111320 * Math.cos(at.lat * Math.PI / 180);
        for (let r = 0; r <= RINGS; r++) {
            const t = r / RINGS;
            const k = falloffAt(Math.min(0.999, t), how) * MOST;
            for (let s = 0; s < AROUND; s++) {
                const a = s / AROUND * Math.PI * 2;
                let [dx, dz] = [Math.cos(a), Math.sin(a)];
                if (how.square) {
                    const m = 1 / Math.max(Math.abs(dx), Math.abs(dz));
                    dx *= m;
                    dz *= m;
                }
                const lon = at.lon + dx * t * radius / mLon;
                const lat = at.lat + dz * t * radius / 110540;
                // The disc is a child of the clay, so in the clay's own frame.
                const p = local(bp.L, lon, lat, (bp.heightAt(lon, lat) ?? 0) + LIFT_M, bp.h0);
                const v = r * AROUND + s;
                positions.set([p.x, p.y, p.z], v * 3);
                colors.set(c.map((x) => 1 - k + k * x), v * 3);
            }
        }
        // A fresh mesh with each fresh clay: the old went with the old root.
        const fresh = !this.entity?.parent;
        if (fresh) this.mesh = new pc.Mesh(bp.app.graphicsDevice);
        this.mesh.setPositions(positions);
        this.mesh.setColors(colors, 3);
        this.mesh.setIndices(this.indices());
        this.mesh.update(pc.PRIMITIVE_TRIANGLES);
        // A mesh instance reads which attributes its mesh has when it is
        // made: made before the colours, it would never draw them.
        if (fresh) this.make();
        this.entity.enabled = true;
    }

    make() {
        const { pc } = this.bp;
        this.entity = new pc.Entity('brush');
        this.entity.addComponent('render', { meshInstances: [new pc.MeshInstance(this.mesh,
            this.material())], castShadows: false, receiveShadows: false });
        this.bp.root.addChild(this.entity);
    }

    indices() {
        if (this.idx) return this.idx;
        const out = [];
        for (let r = 0; r < RINGS; r++) {
            for (let s = 0; s < AROUND; s++) {
                const a = r * AROUND + s;
                const b = r * AROUND + (s + 1) % AROUND;
                out.push(a, a + AROUND, b, b, a + AROUND, b + AROUND);
            }
        }
        this.idx = new Uint32Array(out);
        return this.idx;
    }
}
