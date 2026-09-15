// The one sky (client/lib/light.js), and what it does to a hillside.
//
// The thing that was wrong with the old light cannot be seen in a number
// unless you ask for the right one: it was not that the world was too dark, it
// was that every surface facing away from the sun was the *same* grey, so a
// mountainside had no shape in it. These are the properties that say it has.

import assert from 'node:assert/strict';
import test from 'node:test';

import { lightAt, shade, SUN, tone } from '../lib/light.js';
import { Terrain, bakeLight, openAt, sunlitAt, terrainColour } from '../lib/terrain.js';

const UP = [0, 1, 0];
const away = [-SUN[0], SUN[1] * 0.2, -SUN[2]];
const mean = (v) => (v[0] + v[1] + v[2]) / 3;

test('the sun is brighter than the shade, and warmer', () => {
    const lit = lightAt(UP);
    const dark = lightAt(away);
    assert.ok(mean(lit) > mean(dark) * 1.7, 'a sunlit face reads as sunlit');
    assert.ok(lit[0] / lit[2] > dark[0] / dark[2],
        'the sun is warmer than the sky it is in');
});

test('a shaded face is blue rather than grey', () => {
    const dark = lightAt(away);
    assert.ok(dark[2] > dark[0] * 1.15, 'the shade takes its colour from the sky');
    assert.ok(mean(dark) > 0.25, 'and is not a hole in the picture');
});

test('a surface that can see no sky is darker than one in the open', () => {
    assert.ok(mean(lightAt(UP, 0.2)) < mean(lightAt(UP, 1)) * 0.8,
        'the crease of a hillside is what shows its shape');
});

// Two faces that see the same sky and the same sun are the same colour, and
// should be. What the old light got wrong was that every face turned away from
// the sun was the same grey however it was turned: the shade had no shape.
test('faces turned different ways are different colours', () => {
    const seen = new Set();
    for (const n of [UP, [1, 0.2, 0], [0.5, 0.8, 0.3], [-0.4, 0.6, 0.7],
        [0, 0.05, 1]]) {
        seen.add(lightAt(n).map((c) => c.toFixed(3)).join(','));
    }
    assert.equal(seen.size, 5, 'five directions, five answers');
});

test('the curve lifts the middle and leaves the top alone', () => {
    assert.ok(tone(0.35) > 0.45, 'a third of white is not mud any more');
    assert.equal(tone(1), 1);
    assert.equal(tone(0), 0);
    assert.ok(tone(1.4) <= 1, 'and nothing goes over white');
});

test('the light is the same answer every time it is asked', () => {
    const a = lightAt([0.3, 0.8, -0.5], 0.6);
    const b = lightAt([0.3, 0.8, -0.5], 0.6);
    assert.deepEqual(a, b);
});

test('shade is the surface colour under that light, clamped', () => {
    const c = shade([0.35, 0.4, 0.3], UP);
    assert.ok(c.every((v) => v >= 0 && v <= 1));
    assert.ok(mean(c) > mean([0.35, 0.4, 0.3]), 'daylight, not dusk');
});

test('the ground is a different colour at the river and above the treeline', () => {
    const valley = terrainColour(0.1, 500);
    const alp = terrainColour(0.1, 2600);
    const snow = terrainColour(0.1, 3400);
    assert.ok(mean(snow) > mean(alp), 'snow is the brightest thing in the world');
    assert.ok(mean(alp) > mean(valley), 'and rock is brighter than pasture');
    assert.ok(valley[1] > valley[0] && valley[1] > valley[2], 'the valley is green');
});

test('steep ground is rock whatever height it is at', () => {
    const flat = terrainColour(0.05, 900);
    const cliff = terrainColour(1.2, 900);
    assert.ok(Math.abs(cliff[0] - cliff[1]) < Math.abs(flat[0] - flat[1]),
        'rock has the green taken out of it');
});

test('a point in a hollow sees less sky than one on a shoulder', () => {
    const size = 5;
    const bowl = new Float64Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            bowl[j * size + i] = Math.hypot(i - 2, j - 2) * 40;
        }
    }
    const middle = openAt(bowl, size, 2, 2, 30, 30);
    const rim = openAt(bowl, size, 0, 0, 30, 30);
    assert.ok(middle < rim, `hollow ${middle} should see less than rim ${rim}`);
    assert.ok(middle >= 0 && rim <= 1);
});

// The ground's own shadow (terrain.js sunlitAt): a wall between a point and
// the sun puts the point in shade, and nothing else does.
test('a ridge towards the sun puts the ground behind it in shadow', () => {
    // A wall 30 m high, one cell wide, across the sun's path 10 m away.
    const wallAt = (dist) => (x, z) => {
        const along = (x * SUN[0] + z * SUN[2]) / Math.hypot(SUN[0], SUN[2]);
        return along > dist - 1 && along < dist + 1 ? 30 : 0;
    };
    assert.equal(sunlitAt(wallAt(10), 0, 0, 0, 1), 0, 'behind the wall: none');
    assert.equal(sunlitAt(() => 0, 0, 0, 0, 1), 1, 'flat ground: all of it');
    assert.equal(sunlitAt(wallAt(-10), 0, 0, 0, 1), 1, 'a wall away from the sun: all');
    assert.equal(sunlitAt(() => null, 0, 0, 0, 1), 1, 'past the edge the sun shines');
    assert.equal(sunlitAt(wallAt(10), 0, 40, 0, 1), 1, 'and over the wall it does too');
});

test('the shade behind a ridge is darker than the sun beside it, and bluer', () => {
    const sun = shade([0.4, 0.4, 0.4], UP, 1, 1);
    const shadow = shade([0.4, 0.4, 0.4], UP, 1, 0);
    assert.ok(mean(sun) > mean(shadow) * 1.3);
    assert.ok(shadow[2] / shadow[0] > sun[2] / sun[0], 'the shade is the sky\'s colour');
});

test('bakeLight lights what stands on the ground and leaves the ground alone', () => {
    const size = 3;
    const terrain = new Terrain({ sw: { x: 0, z: 100 }, ne: { x: 100, z: 0 }, size, dem: null });
    const ground = { material: 'terrain', positions: [0, 0, 0], normals: [0, 1, 0],
        colors: [0.5, 0.5, 0.5] };
    const wall = { material: 'wall', positions: [50, 5, 50], normals: [0, 1, 0],
        colors: [0.5, 0.5, 0.5] };
    bakeLight([ground, wall], terrain);
    assert.deepEqual(ground.colors, [0.5, 0.5, 0.5]);
    assert.deepEqual(wall.colors, shade([0.5, 0.5, 0.5], UP, 1, 1));
});
