// EDT.16 — a line's profile: red where it climbs past its kind's gradient,
// marked where the ground falls too fast across it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { profileOf } from '../js/lineprofile.js';
import { lineOf } from '../js/lines.js';

const LAT = 46.3;
const M_LON = 111320 * Math.cos(LAT * Math.PI / 180);
const at = (x, y) => ({ lon: 7.88 + x / M_LON, lat: LAT + y / 110540 });
const east = (lon) => (lon - 7.88) * M_LON;
const north = (lat) => (lat - LAT) * 110540;

test('flat along and across: nothing red, nothing marked', () => {
    const line = lineOf({ kind: 'highway', props: { width: 5 }, nodes: [at(0, 0), at(100, 0)] });
    const p = profileOf(line, { gradient: 12, width: 5 }, () => 600);
    assert.equal(p.over.length, 0);
    assert.equal(p.marks.length, 0);
    assert.ok(p.samples.length >= 100);
});

test('a climb past the kind’s gradient is red where it is', () => {
    // 20 % between 40 m and 60 m, flat either side.
    const bank = (lon) => {
        const x = east(lon);
        return x < 40 ? 0 : x < 60 ? (x - 40) * 0.2 : 4;
    };
    const line = lineOf({ kind: 'highway', props: { width: 5 }, nodes: [at(0, 0), at(100, 0)] });
    const p = profileOf(line, { gradient: 12, width: 5 }, bank);
    assert.equal(p.over.length, 1);
    assert.ok(p.over[0].from > 30 && p.over[0].to < 70);
    assert.equal(profileOf(line, { gradient: 25, width: 5 }, bank).over.length, 0);
});

test('ground falling fast across the road is marked, every few metres', () => {
    // 20 % to the north, across a road running east.
    const slope = (lon, lat) => north(lat) * 0.2;
    const line = lineOf({ kind: 'highway', props: { width: 5 }, nodes: [at(0, 0), at(50, 0)] });
    const p = profileOf(line, { gradient: 12, width: 5 }, slope);
    assert.ok(p.marks.length >= 8, `${p.marks.length} marks`);
    assert.ok(p.marks.every((m) => m.slope > 0.08));
    assert.equal(p.over.length, 0, 'and it is level along');
});
