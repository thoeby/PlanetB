// moverdraw.js — the buses, drawn where the clock puts them (FND.16).
//
// A mover is never baked into a tile: it is a line, a speed and a timetable,
// and every tab works out where it is from the same three things and the same
// clock (client/js/movers.js). So this is the only place one is ever drawn,
// and it draws the product's own canonical GLB — the same meshes the preview
// and the compiler use (client/js/preview.js).

export class MoverDraw {
    constructor(app, pc, { preview, origin } = {}) {
        this.app = app;
        this.pc = pc;
        this.preview = preview;
        this.origin = origin;
        this.entities = new Map();          // mover id -> Entity
    }

    get count() { return this.entities.size; }

    async spawn(row) {
        const { pc } = this;
        const parts = await this.preview.model(row.sha256);
        const entity = new pc.Entity(`mover:${row.id}`);
        entity.addComponent('render', {
            meshInstances: parts.map((p) => new pc.MeshInstance(p.mesh, p.material)),
        });
        this.app.root.addChild(entity);
        this.entities.set(row.id, entity);
        return entity;
    }

    // Put every one of them where this second says it is. `at` is what
    // Movers.where() worked out; the ground under it is asked for so a bus
    // runs on the road rather than through it.
    async place(at, groundAt = () => 0) {
        const seen = new Set();
        for (const one of at) {
            const id = one.mover.id;
            seen.add(id);
            if (!this.entities.has(id)) {
                await this.spawn(one.mover).catch(() => null);
            }
            const entity = this.entities.get(id);
            if (!entity) continue;
            const h = groundAt(one.lon, one.lat);
            const p = this.origin.localOf({ lon: one.lon, lat: one.lat, h });
            entity.setPosition(p.x, p.y, p.z);
            // A heading is degrees clockwise from north; the engine's yaw is
            // about the up axis, and the models face south down it.
            entity.setEulerAngles(0, -one.heading, 0);
        }
        for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.drop(id);
        return this.count;
    }

    // Every entity replaced from its own position: what the floating origin
    // asks of everything drawn in local metres (client/js/origin.js).
    rebased(at, groundAt) { return this.place(at, groundAt); }

    drop(id) {
        this.entities.get(id)?.destroy();
        this.entities.delete(id);
    }

    clear() { for (const id of [...this.entities.keys()]) this.drop(id); }
}
