// FND.15 — what a placed thing is doing, and how this tab learns it changed.
//
// The drawing is client/js/livedraw.js and the browser's; what is here is what
// it draws from: the markings a product carries, the ports that drive each
// part, and the rev that tells a tab what it missed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveWorld, lightOf, marksByPart, poseOf, rgb, saidTo, screenOf, truthy }
    from '../js/live.js';

const LAMP = {
    parts: [{ name: 'head', node: 'head', role: 'light', colour: '#ffd9a0' },
        { name: 'face', node: 'face', role: 'screen' },
        { name: 'hatch', node: 'hatch', role: 'door', axis: 'y', range: 80 }],
    ports: [{ name: 'on', type: 'boolean', default: 'false',
        drives: { part: 'head', what: 'light' } },
    { name: 'colour', type: 'colour', drives: { part: 'head', what: 'colour' } },
    { name: 'brightness', type: 'number', default: '1',
        drives: { part: 'head', what: 'intensity' } },
    { name: 'image', type: 'image', default: '',
        drives: { part: 'face', what: 'texture' } },
    { name: 'open', type: 'number', default: '0',
        drives: { part: 'hatch', what: 'pose' } }],
};

const by = marksByPart(LAMP);

test('a part carries the ports that drive it, and no others', () => {
    assert.deepEqual([...by.keys()], ['head', 'face', 'hatch']);
    assert.deepEqual(by.get('head').ports.map((p) => p.name),
        ['on', 'colour', 'brightness']);
    assert.deepEqual(by.get('face').ports.map((p) => p.name), ['image']);
});

test('what a part is told is the world\'s word, or the product\'s', () => {
    assert.equal(saidTo(by.get('head'), {}, 'light'), 'false');
    assert.equal(saidTo(by.get('head'), { on: true }, 'light'), true);
    assert.equal(saidTo(by.get('head'), {}, 'nothing'), undefined);
});

test('a lamp nobody has switched on is a lamp that is off', () => {
    assert.equal(lightOf(by.get('head'), {}).on, false);
    assert.equal(lightOf(by.get('head'), { on: 'true' }).on, true);
    assert.equal(lightOf(by.get('head'), { on: true }).on, true);
    assert.equal(truthy('1'), true);
});

test('a light is its own colour, and warm white when nobody said', () => {
    assert.deepEqual(lightOf(by.get('head'), { on: true }).colour,
        rgb('#ffd9a0'));
    const blue = lightOf(by.get('head'), { on: true, colour: '#0000ff' });
    assert.deepEqual(blue.colour, [0, 0, 1]);
    assert.equal(lightOf(by.get('head'), { on: true, brightness: '2.5' }).intensity,
        2.5);
});

test('a screen shows a picture the world holds, or nothing', () => {
    assert.equal(screenOf(by.get('face'), {}), null);
    assert.equal(screenOf(by.get('face'), { image: 'not a sha' }), null);
    assert.equal(screenOf(by.get('face'), { image: 'a'.repeat(64) }), 'a'.repeat(64));
});

test('a door is turned as far round its axis as it is opened', () => {
    assert.deepEqual(poseOf(by.get('hatch'), {}), { axis: 'y', degrees: 0 });
    assert.deepEqual(poseOf(by.get('hatch'), { open: 0.5 }), { axis: 'y', degrees: 40 });
    // Past its range is its range: a hatch opens as far as the maker said.
    assert.deepEqual(poseOf(by.get('hatch'), { open: 9 }), { axis: 'y', degrees: 80 });
});

test('a tab asks only for what it missed', async () => {
    const asked = [];
    const live = new LiveWorld({ rpc: async (name, args) => {
        asked.push(args.p_since);
        return args.p_since === 0
            ? [{ instance: 'i1', port: 'on', value: true, rev: 7 }]
            : [];
    } });
    assert.equal(await live.poll(7.8, 46.2), 1);
    assert.equal(live.at('i1', 'on'), true);
    assert.equal(live.since, 7);
    assert.equal(await live.poll(7.8, 46.2), 0);
    assert.deepEqual(asked, [0, 7]);
});

test('what this tab wrote itself is shown without waiting for the sweep', () => {
    const live = new LiveWorld({ rpc: async () => [] });
    live.wrote('i1', 'on', true, 12);
    assert.deepEqual(live.of('i1'), { on: true });
    assert.equal(live.since, 12);
    live.forget();
    assert.deepEqual(live.of('i1'), {});
});
