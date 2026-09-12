// The map in the corner: what span holds the land it has to draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPANS, spanFor } from '../js/hudmap.js';

const at = { lon: 9.69, lat: 46.4 };

test('with no land to draw the map keeps its default span', () => {
    assert.equal(spanFor([], at), 500);
    assert.equal(spanFor(undefined, at), 500);
});

test('an area arrives as a bbox or as a ring, and both are held', () => {
    const box = spanFor([{ bbox: [9.688, 46.399, 9.692, 46.401] }], at);
    const ring = spanFor([{ ring: [[9.688, 46.399], [9.692, 46.399],
        [9.692, 46.401], [9.688, 46.401]] }], at);
    assert.equal(box, ring);
    assert.ok(SPANS.includes(box));
});

test('land further away widens the map until it fits', () => {
    const near = spanFor([{ bbox: [9.688, 46.399, 9.692, 46.401] }], at);
    const far = spanFor([{ bbox: [9.60, 46.34, 9.62, 46.36] }], at);
    assert.ok(far > near, `${far} should be wider than ${near}`);
    // Whatever the span, half of it has to reach the far edge.
    const reach = (9.69 - 9.60) * 111320 * Math.cos((46.4 * Math.PI) / 180);
    assert.ok(far / 2 > reach || far === SPANS.at(-1));
});

test('land on the other side of the world does not widen it past the last span', () => {
    assert.equal(spanFor([{ bbox: [-100, -40, -99, -39] }], at), SPANS.at(-1));
});

test('an area with no geometry at all is ignored, not crashed on', () => {
    assert.equal(spanFor([{}, { ring: [] }], at), 500);
});
