// player.test.js — the parts of the controller that are pure: bilinear ground
// sampling and pushing a circle out of a box. The walk across a stepped
// heightmap is client/test/e2e/walk.spec.js, in a browser, as WP1.4 asks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeightField, Player, slide, WALK, FLY } from '../js/player.js';

const Z = 10, X = 535, Y = 361;

// A field whose height is a plane: 0 m along the west edge, `rise` along the
// east. Interpolation errors show up immediately against a straight line.
function ramp(size, rise) {
    const data = new Uint16Array(size * size);
    for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) data[v * size + u] = Math.round(u / (size - 1) * 65535);
    }
    return new HeightField(data, { size, min: 0, max: rise }, Z, X, Y);
}

test('the field spans its tile and reads its corners', () => {
    const f = ramp(64, 100);
    const east = f.west + f.stepX * (f.size - 1);
    const south = f.north + f.stepZ * (f.size - 1);
    assert.ok(Math.abs(f.at(f.west, f.north)) < 1e-6, `north-west ${f.at(f.west, f.north)}`);
    assert.ok(Math.abs(f.at(east, south) - 100) < 1e-6, `south-east ${f.at(east, south)}`);
    assert.equal(f.at(f.west - 5000, f.north), null, 'and nothing outside it');

    // A z10 tile is about 27 km across at this latitude, and the field covers it.
    assert.ok(east - f.west > 20000 && east - f.west < 30000, `${east - f.west} m wide`);
});

test('sampling between texels is linear', () => {
    const f = ramp(65, 64);
    // Halfway along the ramp is half its rise, whatever the tile's size in
    // metres works out to.
    const west = f.west;
    const east = f.west + f.stepX * (f.size - 1);
    const mid = f.at((west + east) / 2, f.north + f.stepZ * 10);
    assert.ok(Math.abs(mid - 32) < 0.01, `midpoint ${mid}`);
    const quarter = f.at(west + (east - west) / 4, f.north + f.stepZ * 10);
    assert.ok(Math.abs(quarter - 16) < 0.01, `quarter ${quarter}`);
});

const box = (cx, cz, hx, hz, yaw = 0) => ({
    center: [cx, 5, cz], half: [hx, 5, hz], yaw,
});

test('a circle is pushed out of a box along its nearest face', () => {
    const b = box(0, 0, 10, 10);
    const out = slide({ x: 9, y: 5, z: 0 }, [b], 0.5);
    assert.ok(out.x >= 10.5 - 1e-9, `pushed east to ${out.x}`);
    assert.equal(out.z, 0, 'and not sideways');
});

test('sliding keeps the movement along the wall', () => {
    // Walking north-east into a long east-west wall: the north component is
    // stopped, the east component survives.
    const wall = { center: [0, 5, -20], half: [100, 5, 2], yaw: 0 };
    const out = slide({ x: 30, y: 5, z: -21 }, [wall], 0.5);
    assert.equal(out.x, 30, 'east is untouched');
    assert.ok(out.z <= -22.5 + 1e-9, `stopped north of the wall at ${out.z}`);
});

test('a rotated box pushes out along its own axes', () => {
    const b = box(0, 0, 10, 2, Math.PI / 2);   // long north-south
    const inside = slide({ x: 1, y: 5, z: 0 }, [b], 0.5);
    assert.ok(Math.abs(inside.x) > 2, `pushed clear of the narrow side: ${inside.x}`);
    assert.ok(Math.abs(inside.z) < 1e-9, 'and not along the long side');
});

test('a point outside every box is left alone', () => {
    const p = { x: 100, y: 5, z: 100 };
    assert.deepEqual(slide(p, [box(0, 0, 10, 10)], 0.5), p);
});

test('a box the player is above or below does not block', () => {
    const low = { center: [0, 1, 0], half: [10, 1, 10], yaw: 0 };
    const p = { x: 0, y: 30, z: 0 };
    assert.deepEqual(slide(p, [low], 0.5), p, 'walking over a kerb');
});

// A terrain that is flat except for one step, so the walk is easy to predict.
const stepTerrain = (at, height) => ({
    heightAt: (p) => (p.x >= at ? height : 0),
    collidersAt: () => [],
});

test('walking clamps to the ground and flying does not', () => {
    const p = new Player(stepTerrain(10, 4), { mode: WALK, walkSpeed: 5 });
    p.yaw = -Math.PI / 2;                       // face east
    p.held.add('fwd');
    for (let i = 0; i < 40; i++) p.update(0.1);
    assert.ok(p.position.x > 19, `walked ${p.position.x} m east`);
    assert.ok(Math.abs(p.position.y - (4 + p.eye)) < 1e-9, `on the step: ${p.position.y}`);

    p.toggleMode();
    assert.equal(p.mode, FLY);
    p.held.add('up');
    p.update(1);
    assert.ok(p.position.y > 4 + p.eye + 100, `flew up to ${p.position.y}`);
});

test('the player cannot walk through a collider', () => {
    const wall = { center: [10, 5, 0], half: [1, 20, 40], yaw: 0 };
    const terrain = { heightAt: () => 0, collidersAt: () => [wall] };
    const p = new Player(terrain, { mode: WALK, walkSpeed: 5 });
    p.yaw = -Math.PI / 2;
    p.held.add('fwd');
    for (let i = 0; i < 60; i++) p.update(0.1);
    assert.ok(p.position.x <= 9 - p.radius + 1e-9, `stopped at ${p.position.x}`);
});

test('looking is clamped to straight up and straight down', () => {
    const p = new Player(null);
    p.look(0, -100000);
    assert.ok(p.pitch < Math.PI / 2 && p.pitch > Math.PI / 2 - 0.02, `pitch ${p.pitch}`);
    p.look(0, 100000);
    assert.ok(p.pitch > -Math.PI / 2 && p.pitch < -Math.PI / 2 + 0.02, `pitch ${p.pitch}`);
});
