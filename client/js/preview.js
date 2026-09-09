// preview.js — the assets you have placed, drawn as meshes until the tile they
// stand in is compiled again.
//
// A published tile is splats and nothing else, so a bench placed a second ago
// is invisible until some tab renders that tile. Build mode would be unusable
// like that. These are ordinary PlayCanvas meshes built from the same canonical
// GLB `assemble` will bake in, so what you see now is what the tile becomes.
//
// They are a preview, not the world: nothing here writes anything, and the
// splats replace them the moment the new version publishes.

import { meshesOf } from '../lib/glbmesh.js';

const DEG = 180 / Math.PI;

export class InstancePreview {
    // fetch is bound: `this.fetchFn(...)` on a bare window.fetch loses its
    // receiver and throws "Illegal invocation".
    constructor(app, pc, { origin, filesUrl = '', fetchFn = (...a) => fetch(...a) } = {}) {
        this.app = app;
        this.pc = pc;
        this.origin = origin;
        this.filesUrl = filesUrl;
        this.fetchFn = fetchFn;
        this.glbs = new Map();                     // sha256 -> Uint8Array
        this.models = new Map();                   // sha256 -> [MeshInstance specs]
        this.entities = new Map();                 // instance id -> Entity
        this.rows = new Map();                     // instance id -> row
    }

    get count() { return this.entities.size; }

    async glb(sha) {
        if (!this.glbs.has(sha)) {
            const res = await this.fetchFn(`${this.filesUrl}/assets/${sha}.glb`);
            if (!res.ok) throw new Error(`asset ${sha} is not in the store`);
            this.glbs.set(sha, new Uint8Array(await res.arrayBuffer()));
        }
        return this.glbs.get(sha);
    }

    // One pc.Mesh per primitive, made once per digest however many instances
    // share it.
    async model(sha) {
        if (this.models.has(sha)) return this.models.get(sha);
        const { pc } = this;
        const parts = meshesOf(await this.glb(sha)).map((src) => {
            const mesh = new pc.Mesh(this.app.graphicsDevice);
            mesh.setPositions(src.positions);
            mesh.setNormals(src.normals);
            mesh.setIndices(src.indices);
            mesh.update(pc.PRIMITIVE_TRIANGLES);
            const material = new pc.StandardMaterial();
            material.diffuse = new pc.Color(src.colors[0], src.colors[1], src.colors[2]);
            material.update();
            return { mesh, material };
        });
        this.models.set(sha, parts);
        return parts;
    }

    // rows: instance rows, each with the asset's sha256 attached.
    async sync(rows) {
        const seen = new Set();
        for (const row of rows) {
            seen.add(row.id);
            this.rows.set(row.id, row);
            if (!this.entities.has(row.id)) await this.spawn(row);
            this.pose(row);
        }
        for (const id of [...this.entities.keys()]) {
            if (!seen.has(id)) this.drop(id);
        }
        return this.count;
    }

    async spawn(row) {
        const { pc } = this;
        const parts = await this.model(row.sha256);
        const entity = new pc.Entity(`instance:${row.id}`);
        entity.addComponent('render', {
            meshInstances: parts.map((p) => new pc.MeshInstance(p.mesh, p.material)),
        });
        this.app.root.addChild(entity);
        this.entities.set(row.id, entity);
        return entity;
    }

    // Placed by geodetic position, so a rebase moves it correctly rather than
    // by an offset (origin.js says why).
    pose(row) {
        const entity = this.entities.get(row.id);
        if (!entity) return;
        const p = this.origin.localOf({ lon: row.lon, lat: row.lat, h: row.h ?? 0 });
        entity.setPosition(p.x, p.y, p.z);
        entity.setEulerAngles((row.pitch ?? 0) * DEG, (row.yaw ?? 0) * DEG,
            (row.roll ?? 0) * DEG);
        entity.setLocalScale(row.scale ?? 1, row.scale ?? 1, row.scale ?? 1);
    }

    // Called after the floating origin moves: every entity is replaced from its
    // own geodetic position, not translated.
    rebased() {
        for (const row of this.rows.values()) this.pose(row);
    }

    drop(id) {
        this.entities.get(id)?.destroy();
        this.entities.delete(id);
        this.rows.delete(id);
    }

    clear() {
        for (const id of [...this.entities.keys()]) this.drop(id);
    }

    // The instance nearest a local point, within `metres`. Build mode's picker:
    // a click puts the ray on the ground and this says what is standing there.
    nearest(local, metres = 6) {
        let best = null;
        for (const [id, entity] of this.entities) {
            const p = entity.getPosition();
            const d = Math.hypot(p.x - local.x, p.z - local.z);
            if (d <= metres && (!best || d < best.d)) best = { id, d, row: this.rows.get(id) };
        }
        return best?.row ?? null;
    }
}
