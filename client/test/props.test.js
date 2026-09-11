// What a forestry layer says about a stand, and what grows because of it
// (client/lib/props.js). A forest with no species and no age must come out
// exactly as it did before those properties existed.
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { SPECIES, heightRange, maturity, speciesOf, trees } from '../lib/props.js';

const flatGround = { at: () => 0 };
const square = [[[-20, -20], [20, -20], [20, 20], [-20, 20]]];

function seeded() {
    let n = 1;
    return () => {
        n = (n * 1103515245 + 12345) % 2147483648;
        return n / 2147483648;
    };
}

test('a species is found by latin, german, french or english name', () => {
    for (const name of ['picea', 'Fichte', 'epicea', 'spruce']) {
        assert.equal(speciesOf({ species: name }), SPECIES.spruce, name);
    }
    assert.equal(speciesOf({ species: 'fagus' }), SPECIES.beech);
});

test('an unknown species falls back to the leaf type, as before', () => {
    assert.equal(speciesOf({ species: 'zzz' }), SPECIES.needleleaved);
    assert.equal(speciesOf({ species: 'zzz', leaf_type: 'broadleaved' }), SPECIES.broadleaved);
    assert.equal(speciesOf({}), SPECIES.needleleaved);
});

test('age is a fraction of full height, and no age is full height', () => {
    const s = SPECIES.spruce;
    assert.equal(maturity({}, s), 1);
    assert.equal(maturity({ age: 0 }, s), 1, 'a missing age is not a seedling');
    assert.ok(maturity({ age: 10 }, s) < maturity({ age: 40 }, s));
    assert.equal(maturity({ age: 500 }, s), 1, 'nothing grows past its species');
    assert.ok(maturity({ age: 0.5 }, s) >= 0.1, 'and nothing vanishes into the ground');
});

test('a measured canopy height beats the species average', () => {
    assert.deepEqual(heightRange({ height: 20 }, SPECIES.spruce), [16, 24]);
    assert.deepEqual(heightRange({}, SPECIES.spruce), SPECIES.spruce.tall);
});

test('a stand with no properties grows exactly where it grew before', () => {
    const plain = trees([{ rings: square, props: {} }], flatGround, seeded(), 6);
    const aged = trees([{ rings: square, props: { age: 10 } }], flatGround, seeded(), 6);
    assert.equal(plain.count, aged.count, 'age moves no tree, it only shortens it');
    assert.ok(plain.count > 0);
    const tallest = (m) => Math.max(...m.positions.filter((_, i) => i % 3 === 1));
    assert.ok(tallest(aged.canopies) < tallest(plain.canopies), 'a young stand is shorter');
});
