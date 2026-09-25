// livedraw.js — the live parts, drawn over the world.
//
// TASKS-foundation.md FND.15. What each part is doing is live.js's to work
// out; this puts it on the screen, on the entities client/js/preview.js
// already makes for every placed thing near the player — one child entity per
// marked part, with a material of its own (which is why one lamp lighting up
// does not light every lamp of that product).
//
// A light is its own mesh made emissive, with an additive sprite over it so it
// reads as a glow rather than a bright patch of paint. A screen is the marked
// part's own surface, given the picture its `image` port names — a second
// quad over it would be a second surface in exactly the same place, and
// which of the two a frame drew would be the depth buffer's guess. A door
// or a rotor is the part turned about the axis the maker gave it.

import { lightOf, marksByPart, poseOf, screenOf } from './live.js';
import { jointAt } from '../lib/joint.js';

// How far past the part's own size the glow reaches, and the least it is: a
// lamp head is a small thing on a six-metre mast, and a glow the size of the
// head is a glow nobody sees from the other side of the street.
const GLOW = 2.5;
const LEAST_M = 0.6;

// The picture a screen shows: a material's PNG out of the file store
// (client/js/catalog.js stores it there), as a texture, once per sha. The
// bytes arrive later than the frame that asked for them, so whoever is showing
// it is told when they have.
function textureOf(cache, app, pc, filesUrl, sha, ready) {
    if (cache.has(sha)) {
        const held = cache.get(sha);
        if (held.loaded) ready?.();
        else held.waiting.push(ready);
        return held.texture;
    }
    const texture = new pc.Texture(app.graphicsDevice, {
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        mipmaps: true,
    });
    const held = { texture, loaded: false, waiting: [ready] };
    const img = new globalThis.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        texture.setSource(img);
        held.loaded = true;
        for (const fn of held.waiting) fn?.();
        held.waiting = [];
    };
    img.src = `${filesUrl}/assets/${sha}.png`;
    cache.set(sha, held);
    return texture;
}

// Where a part is and how big, in the model's own frame: enough to hang a
// glow or a screen on it without knowing anything else about the mesh.
function boxOf(entity) {
    const box = entity.render?.meshInstances?.[0]?.aabb;
    if (!box) return null;
    const half = box.halfExtents;
    return { centre: box.center.clone(),
        size: [half.x * 2, half.y * 2, half.z * 2] };
}

export class LiveDraw {
    constructor(app, pc, { preview, filesUrl = '' } = {}) {
        this.app = app;
        this.pc = pc;
        this.preview = preview;
        this.filesUrl = filesUrl;
        this.textures = new Map();
        // instance id -> part name -> { glow, screen }
        this.extra = new Map();
    }

    // Everything near the player, put in the state the world says it is in.
    apply(live) {
        for (const [id, row] of this.preview.rows) {
            const by = marksByPart(row.parts);
            if (!by.size) continue;
            const values = live.of(id);
            for (const [name, mark] of by) {
                const part = this.preview.partsOf(id).get(name);
                if (!part) continue;
                if (mark.role === 'light') this.light(id, name, part, mark, values);
                else if (mark.role === 'screen') this.screen(id, name, part, mark, values);
                else if (mark.role === 'joint') this.kept(id, name).joint = mark;
                else this.pose(part, mark, values);
            }
        }
    }

    kept(id, name) {
        if (!this.extra.has(id)) this.extra.set(id, new Map());
        const mine = this.extra.get(id);
        if (!mine.has(name)) mine.set(name, {});
        return mine.get(name);
    }

    // A light: the part's own material made emissive, and an additive sphere
    // over it so it is a glow and not a painted patch.
    light(id, name, part, mark, values) {
        const { pc } = this;
        const { on, colour, intensity } = lightOf(mark, values);
        for (const mi of part.render?.meshInstances ?? []) {
            mi.material.emissive = new pc.Color(...(on ? colour : [0, 0, 0]));
            mi.material.emissiveIntensity = on ? intensity : 0;
            mi.material.update();
        }
        const kept = this.kept(id, name);
        if (!kept.glow) {
            const box = boxOf(part);
            if (!box) return;
            const glow = new pc.Entity(`glow:${name}`);
            glow.addComponent('render', { type: 'sphere' });
            const material = new pc.StandardMaterial();
            material.blendType = pc.BLEND_ADDITIVE;
            material.depthWrite = false;
            material.diffuse = new pc.Color(0, 0, 0);
            material.update();
            for (const mi of glow.render.meshInstances) mi.material = material;
            glow.setLocalScale(...box.size.map((s) => Math.max(LEAST_M, s * GLOW)));
            part.addChild(glow);
            glow.setPosition(box.centre);
            kept.glow = glow;
            kept.material = material;
        }
        kept.glow.enabled = on;
        if (on) {
            kept.material.emissive = new pc.Color(...colour);
            kept.material.emissiveIntensity = intensity;
            kept.material.update();
        }
    }

    // A screen: the marked part's own surface, showing the picture its `image`
    // port names. Nothing named, the surface it was made with.
    screen(id, name, part, mark, values) {
        const { pc } = this;
        const sha = screenOf(mark, values);
        const kept = this.kept(id, name);
        if (kept.showing === sha) return;
        kept.showing = sha;
        for (const mi of part.render?.meshInstances ?? []) {
            if (!kept.was) {
                kept.was = { diffuse: mi.material.diffuse.clone() };
            }
            if (!sha) {
                mi.material.diffuseMap = null;
                mi.material.diffuse = kept.was.diffuse.clone();
                mi.material.emissive = new pc.Color(0, 0, 0);
                mi.material.update();
                continue;
            }
            const material = mi.material;
            material.diffuseMap = textureOf(this.textures, this.app, pc,
                this.filesUrl, sha, () => material.update());
            // A screen makes its own light: what it shows must read the same
            // at dusk as at noon.
            material.diffuse = new pc.Color(1, 1, 1);
            material.emissive = new pc.Color(1, 1, 1);
            material.emissiveIntensity = 0.6;
            material.update();
        }
    }

    // A door or a rotor, turned about the axis the maker gave it.
    pose(part, mark, values) {
        const { axis, degrees } = poseOf(mark, values);
        part.setLocalEulerAngles(axis === 'x' ? degrees : 0,
            axis === 'y' ? degrees : 0, axis === 'z' ? degrees : 0);
    }

    // LV.1: every joint near the player, where the world clock says it is this
    // frame. Nothing is asked of the network: the rows say where each one
    // started and when, and client/lib/joint.js says the rest.
    tick(live, t) {
        for (const [id, parts] of this.extra) {
            for (const [name, kept] of parts) {
                if (!kept.joint) continue;
                const part = this.preview.partsOf(id).get(name);
                if (!part) continue;
                const p = this.jointPose(live, id, kept.joint, t);
                part.setLocalPosition(p.x, p.y, p.z);
                part.setLocalEulerAngles(p.pitch, p.yaw, p.roll);
                part.setLocalScale(p.scale, p.scale, p.scale);
                kept.at = p;
            }
        }
    }

    // Where one joint is at `t`: the rows of every motion port that drives it.
    jointPose(live, id, mark, t) {
        const types = new Map(mark.ports.map((q) => [q.name, q.type]));
        const rows = live.rowsOf(id).filter((r) => types.has(r.port))
            .map((r) => ({ ...r, type: types.get(r.port) }));
        return jointAt(rows, t);
    }

    forget(id) { this.extra.delete(id); }
}
