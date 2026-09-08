// WP1.5's acceptance: publish a new version of a tile the viewer is looking at
// and the viewer picks it up on its own, without the tile ever leaving the
// scene. The poll runs at its real 30 s interval, so this test waits.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { install, tileRows, FILES_ROOT, CLIENT } from './serve.js';
import { republish } from './publish.js';

test.describe.configure({ timeout: 180000 });

let rows = [];

test.beforeAll(() => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try {
        rows = tileRows();
    } catch (err) {
        test.skip(true, `no database to read tiles from: ${err.message}`);
    }
    if (!rows.length) test.skip(true, 'no published tiles — run `bash tools/test-tiles.sh`');
    if (!existsSync(FILES_ROOT)) test.skip(true, `no file store at ${FILES_ROOT}`);
});

test('a republished tile is swapped in within 35 s, with no empty frame',
    async ({ page }) => {
        // No snapshot: the routes read the tile rows fresh, so the republish
        // below is visible to the page's next poll.
        await install(page, null);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('/play.html');
        await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice,
            null, { timeout: 60000 });
        await page.evaluate(() => {
            window.splatworld.setDriving(false);
            window.splatworld.camera.setPosition(0, 3000, 0);
            window.splatworld.camera.setEulerAngles(-90, 0, 0);
        });
        // Wait for a tile that is actually in the scene, not merely claimed: the
        // frame counter below asserts the scene is never empty.
        await page.waitForFunction(
            () => [...window.splatworld.streamer.entries.entries()]
                .some(([k, e]) => k.startsWith('10/') && e.entity),
            null, { timeout: 60000 });

        const before = await page.evaluate(() => {
            const [k] = [...window.splatworld.streamer.entries.entries()]
                .filter(([key, e]) => key.startsWith('10/') && e.entity)
                .map(([key]) => key);
            // Watch every frame from here on: the tile must never be absent.
            window.__watch = { min: Infinity, frames: 0, key: k };
            const tick = () => {
                const n = [...window.splatworld.streamer.entries.values()]
                    .filter((e) => e.entity).length;
                window.__watch.min = Math.min(window.__watch.min, n);
                window.__watch.frames++;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return { key: k, url: window.splatworld.streamer.entries.get(k).asset.file.url };
        });

        const [z, x, y] = before.key.split('/').map(Number);
        const sha = republish(z, x, y);
        expect(before.url).not.toContain(sha);

        // The poll is on its 30 s timer; give it 35.
        await page.waitForFunction((k) => window.splatworld.streamer.swaps > 0
            && window.splatworld.streamer.entries.get(k)?.entity, before.key,
        { timeout: 35000 });

        const after = await page.evaluate((k) => ({
            url: window.splatworld.streamer.entries.get(k).asset.file.url,
            swaps: window.splatworld.streamer.swaps,
            watch: window.__watch,
        }), before.key);

        expect(after.url, 'the entity is on the new bytes').toContain(sha);
        expect(after.swaps).toBeGreaterThan(0);
        expect(after.watch.frames, 'frames were actually counted').toBeGreaterThan(100);
        expect(after.watch.min, 'never a frame with no tiles').toBeGreaterThan(0);
        expect(errors, errors.join('\n')).toEqual([]);
    });
