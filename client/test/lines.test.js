// EDT.15 — a line's handles survive the world: what is written (the curve
// densified, and props.ctrl) reads back as the same nodes, corners and widths.
import test from 'node:test';
import assert from 'node:assert/strict';

import { featureOf, fromRow, lineOf, metresOf } from '../js/lines.js';
import { NODE_DEEDS, handlesOf, hitAt, widthsOf } from '../js/lineedit.js';

const M_LON = 111320 * Math.cos(46.3 * Math.PI / 180);
const at = (x, y) => ({ lon: 7.88 + x / M_LON, lat: 46.3 + y / 110540 });

const road = () => lineOf({ kind: 'highway', props: { highway: 'track', width: 3 },
    nodes: [at(0, 0), at(40, 5), at(80, -10), at(120, 0)], corner: [false, true, false, false] });

test('ctrl → geometry → ctrl round-trips', () => {
    const line = road();
    line.props.widths = [3, 4, 5, 3];
    const f = featureOf(line, () => 650);
    assert.equal(f.geom.type, 'LineString');
    assert.ok(f.geom.coordinates.length > 120);
    assert.ok(f.geom.coordinates.every((c) => c.length === 3 && c[2] === 650));
    const back = fromRow({ id: 'x', kind: f.kind, props: f.props, geom: f.geom }, []);
    assert.deepEqual(back.nodes, line.nodes);
    assert.deepEqual(back.corner, line.corner);
    assert.deepEqual(back.props.widths, [3, 4, 5, 3]);
    assert.equal(back.props.ctrl, undefined, 'ctrl is the row’s, not a field');
    assert.ok(Math.abs(metresOf(back) - metresOf(line)) < 1e-6);
});

test('a line drawn elsewhere (no ctrl) comes back as corners at its points', () => {
    const back = fromRow({ id: 'y', kind: 'highway', props: { highway: 'path' },
        geom: { type: 'LineString',
            coordinates: [[7.88, 46.3, 1], [7.881, 46.3, 1], [7.881, 46.301, 1]] } }, []);
    assert.equal(back.nodes.length, 3);
    assert.deepEqual(back.corner, [true, true, true]);
});

test('hits: a node of the selected line, its handle, and a curve', () => {
    const line = road();
    assert.equal(hitAt([line], line, at(40.3, 5.2), 1).kind, 'node');
    const h = handlesOf(line)[2];
    assert.equal(hitAt([line], line, h, 0.2).kind, 'handle');
    const c = hitAt([line], null, at(20, 2.4), 2);
    assert.equal(c.kind, 'curve');
    assert.equal(c.i, 0);
    assert.equal(hitAt([line], null, at(20, 40), 2), null);
    assert.deepEqual(widthsOf(line), [3, 3, 3, 3]);
});

test('split, reverse and join are one step each and keep the line whole', () => {
    const items = [road()];
    const lines = { items, past: [], get live() { return this.items; },
        remember() { this.past.push(1); }, changed(l) { l.state = 'changed'; } };
    const state = { lines };
    assert.equal(NODE_DEEDS.split(state, items[0], 2), 'split in two');
    assert.equal(lines.items.length, 2);
    assert.equal(lines.items[0].nodes.length, 3);
    assert.equal(lines.items[1].nodes.length, 2);
    assert.equal(NODE_DEEDS.join(state, lines.items[0], 2), 'joined into one');
    assert.equal(lines.items.length, 1);
    assert.equal(lines.items[0].nodes.length, 4);
    NODE_DEEDS.reverse(state, lines.items[0]);
    assert.deepEqual(lines.items[0].nodes[0], at(120, 0));
});
