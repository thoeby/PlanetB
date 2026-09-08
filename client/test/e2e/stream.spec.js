// The browser leg of WP1.3: fly a scripted path over the test region, assert
// the loaded set at five checkpoints, and check that nothing ends up placed
// beyond 1e5 m in local coordinates. The tiles are the ones
// tools/make-test-tiles.mjs published, streamed as real .sog bundles.

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

async function boot(page) {
    await install(page, rows);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/play.html');
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice, null,
        { timeout: 60000 });
    // These tests script the camera, so the player lets go of it — including
    // where it points, which the player would otherwise own.
    await page.evaluate(() => {
        window.splatworld.setDriving(false);
        window.splatworld.camera.setEulerAngles(-90, 0, 0);
    });
    expect(errors, errors.join('\n')).toEqual([]);
    return errors;
}

// Puts the camera at an altitude over the anchor and waits for the streamer to
// stop changing its mind: four loads start per frame, so a big jump settles
// over several.
async function flyTo(page, altitude) {
    return page.evaluate(async (y) => {
        const { camera, streamer } = window.splatworld;
        camera.setPosition(0, y, 0);
        camera.setEulerAngles(-90, 0, 0);        // straight down at the region
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        let last = '';
        for (let i = 0; i < 400; i++) {
            await frame();
            const now = [...streamer.entries.keys()].sort().join(' ');
            if (now === last && streamer.pending === 0 && i > 8) break;
            last = now;
        }
        return {
            loaded: [...streamer.entries.keys()].sort(),
            placed: [...streamer.entries.values()].filter((e) => e.entity).length,
            worst: Math.max(0, ...[...streamer.entries.values()]
                .filter((e) => e.entity)
                .map((e) => {
                    const p = e.entity.getLocalPosition();
                    return Math.hypot(p.x, p.y, p.z);
                })),
        };
    }, altitude);
}

test('the engine and the test tiles load', async ({ page }) => {
    await boot(page);
    const info = await page.evaluate(() => ({
        device: window.splatworld.app.graphicsDevice.deviceType,
        tiles: window.splatworld.rows.length,
    }));
    expect(info.tiles).toBeGreaterThanOrEqual(7);
    const at = await flyTo(page, 1e6);
    expect(at.loaded).toEqual([
        '10/535/361', '10/535/362', '10/536/361', '10/536/362']);
    expect(at.placed, 'every claimed tile became an entity').toBe(4);

    // The .sog bundles are not merely fetched: the engine decoded them and put
    // the gaussians on the device.
    const splats = await page.evaluate(() => [...window.splatworld.streamer.entries.values()]
        .map((e) => (e.entity ? e.asset?.resource?.gsplatData?.numSplats ?? 0 : 0)));
    expect(splats).toEqual([2304, 2304, 2304, 2304]);

    // And something was actually drawn: the frame is not the clear colour.
    const painted = await page.evaluate(() => {
        const c = document.getElementById('view');
        const gl = window.splatworld.app.graphicsDevice.gl;
        const px = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let odd = 0;
        for (let i = 0; i < px.length; i += 4) {
            if (Math.abs(px[i] - 13) > 6 || Math.abs(px[i + 1] - 15) > 6) odd++;
        }
        return odd;
    });
    expect(painted, 'splats reached the framebuffer').toBeGreaterThan(1000);
});

test('five checkpoints down and back up the ladder', async ({ page }) => {
    await boot(page);
    const seen = [];
    let worst = 0;
    for (const alt of [2e7, 5e6, 1e6, 2e3, 2e7]) {
        const at = await flyTo(page, alt);
        seen.push(at.loaded);
        worst = Math.max(worst, at.worst);
    }
    expect(seen[0], 'from 20 000 km, one z6 tile').toEqual(['6/33/22']);
    expect(seen[1], 'at 5 000 km, both z8 parents').toEqual(['8/133/90', '8/134/90']);
    expect(seen[2], 'at 1 000 km, the four z10 children').toEqual([
        '10/535/361', '10/535/362', '10/536/361', '10/536/362']);
    // Two kilometres up the camera sees about 1.6 km of ground, so the real
    // frustum culls most of a 27 km block. The node test covers the same
    // checkpoint without culling; here the point is that culling happens.
    expect(seen[3].length, 'at 2 km, the frustum culls the block').toBeLessThan(4);
    expect(seen[3], 'and keeps the tile under the camera').toContain('10/535/361');
    for (const k of seen[3]) expect(seen[2]).toContain(k);
    expect(seen[4], 'coarse again on the way out').toEqual(['6/33/22']);
    expect(worst, 'no entity beyond 1e5 m in local coordinates').toBeLessThan(1e5);
});

test('flying 60 km rebases the origin and keeps entities near it', async ({ page }) => {
    await boot(page);
    await flyTo(page, 2e3);
    const after = await page.evaluate(async () => {
        const { camera, origin, streamer } = window.splatworld;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        for (let step = 0; step < 12; step++) {
            const p = camera.getPosition();
            camera.setPosition(p.x + 5000, p.y, p.z);
            await frame();
        }
        const p = camera.getPosition();
        return {
            rebases: origin.rebases,
            drift: Math.hypot(p.x, p.z),
            worst: Math.max(0, ...[...streamer.entries.values()]
                .filter((e) => e.entity)
                .map((e) => {
                    const q = e.entity.getLocalPosition();
                    return Math.hypot(q.x, q.y, q.z);
                })),
        };
    });
    expect(after.rebases, 'the anchor followed the camera').toBeGreaterThan(0);
    expect(after.drift, 'the camera never strays far from the anchor').toBeLessThan(11000);
    expect(after.worst, 'and neither does anything it placed').toBeLessThan(1e5);
});
