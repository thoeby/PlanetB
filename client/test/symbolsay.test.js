// What the Symbols editor says about a symbol without asking the database:
// the line under each layer in the stack, the trouble on a field, and which
// widget a property the symbol compares against wants.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fieldTrouble, layerSays, valueWords } from '../lib/symbols.js';
import { propsOf, widgetOf } from '../js/symboltry.js';

test('a layer says what it is set to, in the order its fields are named', () => {
    assert.equal(layerSays({ layer: 'repeat',
        params: { spacing: 30, side: 'right', offset: 4 } }),
    'every (m) 30 · side right · off the centre (m) 4');
    assert.equal(layerSays({ layer: 'surface', params: {} }), '');
    assert.equal(layerSays({ layer: 'no such thing', params: { a: 1 } }), '');
});

test('and says when it only does it sometimes', () => {
    assert.match(layerSays({ layer: 'place', params: { yaw: 90 },
        when: [{ prop: 'lit', op: 'eq', value: 'yes' }] }), /when 1 thing\(s\) hold/);
});

// A number read off the feature is written the way one is typed, not as JSON.
test('a value read off the feature reads as words', () => {
    assert.equal(valueWords({ prop: 'lanes', times: 3, min: 6, else: 6 }),
        'lanes × 3 min 6 else 6');
    assert.equal(valueWords({ prop: 'height', else: { prop: 'levels', times: 3, else: 6 } }),
        'height else levels × 3 else 6');
    assert.equal(valueWords(6), '6');
    assert.equal(valueWords(['a', 'b']), 'a, b');
});

test('a product of the wrong kind is named with the field it is in', () => {
    const layer = { layer: 'repeat', params: { segment: 'SASPHALTASPH' } };
    const trouble = fieldTrouble(layer, () => 'material');
    assert.equal(trouble.field, 'segment');
    assert.match(trouble.said, /repeating piece is needed here/);
    assert.match(trouble.said, /is a surface material/);
    // The right kind, and one the page has not looked up, are both fine.
    assert.equal(fieldTrouble(layer, () => 'segment'), null);
    assert.equal(fieldTrouble(layer, () => null), null);
});

test('the widget a property wants is the one its own value implies', () => {
    assert.equal(widgetOf('yes'), 'switch');
    assert.equal(widgetOf('no'), 'switch');
    assert.equal(widgetOf(true), 'switch');
    assert.equal(widgetOf(2), 'number');
    assert.equal(widgetOf('2'), 'number');
    assert.equal(widgetOf('secondary'), 'text');
    assert.equal(widgetOf(['track', 'path']), 'text');
    assert.equal(widgetOf(undefined), 'text');
});

test('the sample offers every property the symbol asks about, itself first', () => {
    const symbol = {
        filter: [{ prop: 'highway', op: 'eq', value: 'secondary' }],
        layers: [{ layer: 'surface', params: {} },
            { layer: 'repeat', params: {},
                when: [{ prop: 'lit', op: 'eq', value: 'yes' },
                    { prop: 'highway', op: 'ne', value: 'track' }] }],
    };
    assert.deepEqual(propsOf(symbol), [['highway', 'secondary'], ['lit', 'yes']]);
    assert.deepEqual(propsOf({}), []);
});
