// lines.js — a land's lines while Lines is open (PLAN-editors.md §2.3).
//
// A line is a `feature` row (LineStringZ) whose kind is a line kind of the
// vocabulary. What is stored is the curve densified (client/lib/spline.js), so
// QGIS, the compiler and the steepness check see exactly what was drawn; the
// control nodes and their smooth/corner flags ride along in `props.ctrl` so
// editing it again gives the handles back. A line edited in QGIS loses `ctrl`
// and comes back as corners.
//
// Nothing here decides who may write: saveFeature asks the database, whose
// row-level security does (Invariant 6).

import * as api from './api.js';
import { dropFeature, saveFeature } from './edit.js';
import { densify, frameAt, length } from '../lib/spline.js';
import { entryOf } from '../lib/kinds.js';

let serial = 0;

// A line as the editor holds it.
export function lineOf({ id = null, kind, props = {}, nodes, corner, entry }) {
    serial += 1;
    return { key: `l${serial}`, id, kind, props: { ...props },
        nodes: nodes.map((n) => ({ lon: n.lon, lat: n.lat })),
        corner: corner ?? nodes.map(() => Boolean(entry?.corner)),
        state: id ? 'saved' : 'new' };
}

// A row of area_lines back into nodes: its ctrl if it has one, its points as
// corners if QGIS (or anybody else) drew it.
export function fromRow(row, entries) {
    const ctrl = row.props?.ctrl;
    const coords = row.geom?.type === 'MultiLineString' ? row.geom.coordinates[0]
        : row.geom?.coordinates ?? [];
    const nodes = ctrl?.nodes?.length > 1
        ? ctrl.nodes.map(([lon, lat]) => ({ lon, lat }))
        : coords.map(([lon, lat]) => ({ lon, lat }));
    const corner = ctrl?.nodes?.length > 1 ? ctrl.nodes.map((_, i) => Boolean(ctrl.corner?.[i]))
        : nodes.map(() => true);
    const props = { ...(row.props ?? {}) };
    delete props.ctrl;
    return lineOf({ id: row.id, kind: row.kind, props, nodes, corner,
        entry: entryOf(entries, row.kind, props) });
}

// The stored curve: densified in a metric frame at the line's first node,
// each point at the ground's height there.
export function curveOf(line) {
    if (line.nodes.length < 2) return line.nodes.map((n) => ({ ...n }));
    const f = frameAt(line.nodes[0].lon, line.nodes[0].lat);
    return densify(line.nodes.map((n) => f.toXZ(n.lon, n.lat)), line.corner).map(f.toLonLat);
}

export function metresOf(line) {
    const f = frameAt(line.nodes[0]?.lon ?? 0, line.nodes[0]?.lat ?? 0);
    return length(curveOf(line).map((p) => f.toXZ(p.lon, p.lat)));
}

// What is written: GeoJSON with the ground's height on every point, and the
// kind's fields with the handles beside them.
export function featureOf(line, heightAt) {
    const pts = curveOf(line);
    return {
        id: line.id, kind: line.kind,
        geom: { type: 'LineString',
            coordinates: pts.map((p) => [p.lon, p.lat, heightAt(p.lon, p.lat) ?? 0]) },
        props: { ...line.props,
            ctrl: { nodes: line.nodes.map((n) => [n.lon, n.lat]),
                corner: line.corner.map((c) => (c ? 1 : 0)) } },
    };
}

// The lines as Undo keeps them: without what is drawn from them.
const frozen = (items) => JSON.stringify(items, (k, v) => (k === 'cache' ? undefined : v));

export class Lines {
    constructor(area, items = []) {
        this.area = area;
        this.items = items;
        this.past = [];
        this.future = [];
    }

    static async load(area, entries) {
        const rows = await api.rpc('area_lines', { area: area.id }).catch(() => []);
        return new Lines(area, (rows ?? []).map((r) => fromRow(r, entries)));
    }

    get live() { return this.items.filter((l) => l.state !== 'deleted'); }

    get dirty() { return this.items.some((l) => l.state !== 'saved'); }

    // Before every change: what was, so Undo can put it back.
    remember() {
        this.past.push(frozen(this.items));
        this.future.length = 0;
    }

    undo() { return this.step(this.past, this.future); }

    redo() { return this.step(this.future, this.past); }

    step(from, to) {
        const was = from.pop();
        if (!was) return false;
        to.push(frozen(this.items));
        this.items = JSON.parse(was);
        return true;
    }

    add(line) {
        this.remember();
        this.items.push(line);
        return line;
    }

    changed(line) {
        if (line.state === 'saved') line.state = 'changed';
        line.cache = null;
    }

    remove(line) {
        this.remember();
        if (line.id) line.state = 'deleted';
        else this.items = this.items.filter((l) => l !== line);
    }

    // Everything unsaved, through the database's own permission (Invariant 6).
    async save(heightAt) {
        let saved = 0;
        let dropped = 0;
        for (const line of this.items) {
            if (line.state === 'deleted') {
                await dropFeature(this.area, line.id);
                dropped += 1;
            } else if (line.state !== 'saved' && line.nodes.length > 1) {
                const got = await saveFeature(this.area, featureOf(line, heightAt));
                line.id = got.id ?? line.id;
                saved += 1;
            }
        }
        this.items = this.items.filter((l) => l.state !== 'deleted');
        for (const l of this.items) l.state = 'saved';
        this.past.length = 0;
        this.future.length = 0;
        return { saved, dropped };
    }
}
