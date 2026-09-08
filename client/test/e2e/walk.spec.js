// WP1.4's acceptance: a player walking across a test tile whose heightmap has a
// step ends at the expected height. The heightmap is injected rather than
// published — a step is the shape that makes bilinear sampling and the ground
// clamp easy to check, and the tiles WP1.2 publishes are smooth hills.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { install, testTileRows, FILES_ROOT, CLIENT } from './serve.js';

let rows = [];

test.beforeAll(() => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try {
        rows = testTileRows();
    } catch (err) {
        test.skip(true, `no database to read tiles from: ${err.message}`);
    }
    if (!rows.length) test.skip(true, 'no published tiles — run `bash tools/test-tiles.sh`');
    if (!existsSync(FILES_ROOT)) test.skip(true, `no file store at ${FILES_ROOT}`);
});

const STEP_H = 12;

async function boot(page) {
    await install(page, rows);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/play.html');
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice,
        null, { timeout: 60000 });
    // Bring a z10 tile in, then hand the camera back to the player.
    await page.evaluate(() => {
        window.splatworld.setDriving(false);
        window.splatworld.camera.setPosition(0, 3000, 0);
    });
    await page.waitForFunction(
        () => [...window.splatworld.streamer.entries.keys()].some((k) => k.startsWith('10/')),
        null, { timeout: 60000 });
    expect(errors, errors.join('\n')).toEqual([]);
}

test('walking across a step ends at the step height', async ({ page }) => {
    await boot(page);
    const walk = await page.evaluate(async (stepH) => {
        const { HeightField } = await import('./js/player.js');
        const tm = await import('./lib/tilemath.js');
        const { streamer, terrain, player, origin, setDriving } = window.splatworld;
        setDriving(true);

        const k = [...streamer.entries.keys()].find((key) => key.startsWith('10/'));
        const [z, x, y] = k.split('/').map(Number);

        // Flat at 0 m for the western 24 columns, stepH for the rest.
        const size = 64, stepAt = 24;
        const data = new Uint16Array(size * size);
        for (let v = 0; v < size; v++) {
            for (let u = 0; u < size; u++) data[v * size + u] = u >= stepAt ? 65535 : 0;
        }
        const field = new HeightField(data, { size, min: 0, max: stepH }, z, x, y);
        terrain.fields.set(k, field);
        terrain.colliders.set(k, []);
        terrain.wanted.add(k);

        // Start four columns in from the west edge, halfway down the tile.
        const start = tm.lonLatFromLocal(field.origin, {
            x: field.west + field.stepX * 4, y: 0, z: field.north + field.stepZ * (size / 2),
        });
        player.position = origin.localOf(start);
        player.yaw = -Math.PI / 2;               // face east
        player.walkSpeed = 400;
        player.held.add('fwd');
        player.update(0.001);
        const before = player.position.y;

        for (let i = 0; i < 300; i++) player.update(0.1);
        return {
            before,
            after: player.position.y,
            eye: player.eye,
            expected: stepH + player.eye,
            grounded: player.grounded,
            tile: k,
        };
    }, STEP_H);

    expect(walk.grounded, 'the player found ground').toBe(true);
    expect(Math.abs(walk.before - walk.eye), 'started on the low side of the step')
        .toBeLessThan(0.05);
    expect(Math.abs(walk.after - walk.expected),
        'ends at the step height within 0.05 m').toBeLessThan(0.05);
});

test('a collider stops the player and lets them slide', async ({ page }) => {
    await boot(page);
    const run = await page.evaluate(async () => {
        const { HeightField } = await import('./js/player.js');
        const tm = await import('./lib/tilemath.js');
        const { streamer, terrain, player, origin, setDriving } = window.splatworld;
        setDriving(true);

        const k = [...streamer.entries.keys()].find((key) => key.startsWith('10/'));
        const [z, x, y] = k.split('/').map(Number);
        const size = 8;
        const field = new HeightField(new Uint16Array(size * size),
            { size, min: 0, max: 1 }, z, x, y);
        terrain.fields.set(k, field);
        terrain.wanted.add(k);

        // Colliders live in the tile's own frame, as they do in colliders.json;
        // Terrain moves them into the anchor's.
        const sx = field.west + field.stepX * 3;
        const sz = field.north + field.stepZ * 4;
        player.position = origin.localOf(tm.lonLatFromLocal(field.origin,
            { x: sx, y: 0, z: sz }));
        player.yaw = -Math.PI / 2;
        player.walkSpeed = 50;
        player.update(0.001);

        // A north-south wall 200 m east of where the player starts.
        terrain.colliders.set(k, [{
            center: [sx + 200, 0, sz], half: [2, 50, 400], yaw: 0,
        }]);
        const startX = player.position.x;
        player.held.add('fwd');
        for (let i = 0; i < 200; i++) player.update(0.1);
        const travelled = player.position.x - startX;

        // Now also press north: the wall stops east, the north component runs.
        const startZ = player.position.z;
        player.held.add('left');
        for (let i = 0; i < 100; i++) player.update(0.1);
        return {
            travelled, slidZ: player.position.z - startZ,
            stillEast: player.position.x - startX - travelled,
        };
    });

    // 200 m to the wall, less its 2 m half-width and the player's radius.
    expect(run.travelled, 'walked up to the wall').toBeGreaterThan(190);
    expect(run.travelled, 'and no further').toBeLessThan(198.1);
    expect(Math.abs(run.slidZ), 'then slid along it').toBeGreaterThan(100);
    expect(Math.abs(run.stillEast), 'without pushing through').toBeLessThan(1);
});
