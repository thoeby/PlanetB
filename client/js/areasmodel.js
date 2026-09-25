// areasmodel.js — a land's areas while Survey → Areas is open (EDT.20-22).
//
// An area is a `feature` row (Polygon or MultiPolygon Z) of a polygon kind of
// the vocabulary. While it is being edited it is held as polygons in a metric
// frame at the land's middle (client/lib/spline.js frameAt), where
// client/lib/polyops.js can clip, join and cut it. Written through
// saveFeature and dropFeature: the database's row-level security decides
// (Invariant 6).

import { frameAt } from '../lib/spline.js';
import { ringsOf } from './sculpt.js';

let serial = 0;

export function frameOf(land) {
    const b = land.bbox;
    return frameAt((b.west + b.east) / 2, (b.south + b.north) / 2);
}

// GeoJSON (degrees) into polygons in the frame, and back.
export function polysOf(f, geom) {
    const list = geom?.type === 'Polygon' ? [geom.coordinates]
        : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
    return list.map((rings) => rings.map((r) => {
        const ring = r.map(([lon, lat]) => f.toXZ(lon, lat));
        const [a, z] = [ring[0], ring.at(-1)];
        return a[0] === z[0] && a[1] === z[1] ? ring.slice(0, -1) : ring;
    }));
}

export function geomOf(f, polys) {
    const ring = (r) => {
        const pts = r.map((p) => {
            const g = f.toLonLat(p);
            return [g.lon, g.lat];
        });
        return [...pts, pts[0]];
    };
    const all = polys.map((p) => p.map(ring));
    return all.length === 1 ? { type: 'Polygon', coordinates: all[0] }
        : { type: 'MultiPolygon', coordinates: all };
}

// The land itself as polygons, for clipping to it.
export const landPolys = (f, land) => polysOf(f, { type: 'MultiPolygon',
    coordinates: ringsOf(land.outline).map((r) => [r]) });

export function areaOf({ id = null, kind, props = {}, polys, state }) {
    serial += 1;
    return { key: `a${serial}`, id, kind, props: { ...props }, polys,
        state: state ?? (id ? 'saved' : 'new') };
}

export class Areas {
    constructor(land, rows = []) {
        this.land = land;
        this.f = frameOf(land);
        this.items = rows.map((r) => areaOf({ id: r.id, kind: r.kind, props: r.props ?? {},
            polys: polysOf(this.f, r.geom) }));
        this.past = [];
        this.future = [];
    }

    get live() { return this.items.filter((a) => a.state !== 'deleted'); }

    get dirty() { return this.items.some((a) => a.state !== 'saved'); }

    remember() {
        this.past.push(JSON.stringify(this.items));
        this.future.length = 0;
    }

    undo() { return this.step(this.past, this.future); }

    redo() { return this.step(this.future, this.past); }

    step(from, to) {
        const was = from.pop();
        if (!was) return false;
        to.push(JSON.stringify(this.items));
        this.items = JSON.parse(was);
        return true;
    }

    add(area) {
        this.remember();
        this.items.push(area);
        return area;
    }

    changed(area) { if (area.state === 'saved') area.state = 'changed'; }

    remove(area) {
        this.remember();
        if (area.id) area.state = 'deleted';
        else this.items = this.items.filter((a) => a !== area);
    }

    // What a row of it is, as the world stores it.
    featureOf(area) {
        return { id: area.id, kind: area.kind, props: area.props,
            geom: geomOf(this.f, area.polys) };
    }
}
