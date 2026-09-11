// What the rules make of a stand and a building (client/lib/props.js). The
// vocabulary is not here and not in props.js: these rules are what a world's
// own `build_rule` rows say (db/0037_ruleseed.sql seeds one set of them).
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildings, maturity, trees } from '../lib/props.js';

const flat = { at: () => 0 };
const square = [[[-20, -20], [20, -20], [20, 20], [-20, 20]]];

function seeded() {
    let n = 1;
    return () => {
        n = (n * 1103515245 + 12345) % 2147483648;
        return n / 2147483648;
    };
}

const SPRUCE = {
    name: 'spruce', kind: 'forest',
    filter: [{ prop: 'baumart', op: 'in', value: ['picea', 'fichte'] }],
    style: { height: [18, 30], taper: 0.24, sides: 6, mature: 70, age_prop: 'alter' },
};
const ANY_FOREST = { name: 'any', kind: 'forest', filter: [], style: { height: [12, 22] } };

const tallest = (mesh) => Math.max(...mesh.positions.filter((_, i) => i % 3 === 1));

test('age is a fraction of the rule\'s own maturity', () => {
    assert.equal(maturity(undefined, 70), 1, 'no age is grown');
    assert.equal(maturity(40, undefined), 1, 'no maturity in the rule is grown');
    assert.ok(maturity(10, 70) < maturity(40, 70));
    assert.equal(maturity(500, 70), 1);
    assert.ok(maturity(0.5, 70) >= 0.1, 'nothing vanishes into the ground');
});

test('a rule decides the species, by whatever column the rule names', () => {
    const rules = [SPRUCE, ANY_FOREST];
    const stand = (baumart) => trees(
        [{ kind: 'forest', rings: square, props: { baumart } }], flat, seeded(), 6, rules);
    const spruce = stand('Fichte');
    const other = stand('Buche');
    assert.ok(tallest(spruce.canopies) > tallest(other.canopies),
        'the spruce rule is taller than the else-rule');
    assert.equal(spruce.count, other.count, 'and the scatter is the same either way');
});

test('the age column is the one the rule names, not one called age', () => {
    const rules = [SPRUCE];
    const stand = (props) => trees(
        [{ kind: 'forest', rings: square, props }], flat, seeded(), 6, rules);
    const grown = stand({ baumart: 'picea' });
    const young = stand({ baumart: 'picea', alter: 7 });
    assert.ok(tallest(young.canopies) < tallest(grown.canopies));
    const ignored = stand({ baumart: 'picea', age: 7 });
    assert.equal(tallest(ignored.canopies), tallest(grown.canopies),
        'a column no rule names changes nothing');
});

test('with no rules at all a forest is still a forest', () => {
    const bare = trees([{ kind: 'forest', rings: square, props: {} }], flat, seeded(), 6, []);
    assert.ok(bare.count > 0);
    assert.ok(tallest(bare.canopies) > 0);
});

test('a building takes its height from the rule\'s fallback chain', () => {
    const rules = [{ name: 'b', kind: 'footprint', filter: [],
        style: { height: { prop: 'hoehe', else: { prop: 'geschosse', times: 3, else: 6 } } } }];
    const block = (props) => buildings(
        [{ kind: 'footprint', rings: square, props }], flat, rules);
    const measured = block({ hoehe: 21 });
    const storeys = block({ geschosse: 4 });
    const neither = block({});
    assert.equal(tallest(measured.walls), 21 - 0.5);
    assert.equal(tallest(storeys.walls), 12 - 0.5);
    assert.equal(tallest(neither.walls), 6 - 0.5);
});

test('the roof a rule asks for is the roof that is built', () => {
    const of = (roof) => buildings([{ kind: 'footprint', rings: square, props: {} }], flat,
        [{ name: 'r', kind: 'footprint', filter: [], style: { roof, height: 6 } }]);
    assert.ok(tallest(of('gable').roofs) > tallest(of('flat').roofs), 'a gable has a ridge');
    assert.ok(tallest(of('hip').roofs) > tallest(of('flat').roofs));
    assert.equal(tallest(of('Satteldach').roofs), tallest(of('flat').roofs),
        'an unknown word is flat: which word means gable is a rule, not a guess');
});
