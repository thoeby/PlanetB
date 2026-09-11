// WP5.4's browser leg: ?xr=1 lowers the budget before anything is entered, and
// a browser with no headset says so instead of throwing. There is no XR device
// in headless chromium and none in this container, so what a session actually
// looks like is a manual check — docs/xr.md lists it.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { install, testTileRows, CLIENT, FILES_ROOT } from './serve.js';
import { revealPanels } from './worker.js';

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

async function boot(page, query = '') {
    await install(page, rows);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`/play.html${query}`);
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice, null,
        { timeout: 60000 });
    await revealPanels(page);
    return errors;
}

const budget = (page) => page.evaluate(() => window.splatworld.streamer.limits.splats);

test('?xr=1 takes the headset budget, and the plain page keeps its own',
    async ({ page }) => {
        const errors = await boot(page, '?xr=1');
        expect(await budget(page)).toBe(8e6);
        await expect(page.locator('#xr')).toBeVisible();
        expect(errors, errors.join('\n')).toEqual([]);

        await boot(page, '');
        expect(await budget(page)).toBe(25e6);
        await expect(page.locator('#xr')).toBeHidden();
    });

test('a browser with no headset says so and stays a page', async ({ page }) => {
    const errors = await boot(page, '?xr=1');
    // Headless chromium has no XR runtime: what matters is that the page tells
    // the player that, keeps rendering, and offers no button that cannot work.
    await expect(page.locator('.xr-status')).toHaveText('no headset on this browser');
    await expect(page.locator('.xr-enter')).toBeDisabled();
    expect(await page.evaluate(() => window.splatworld.app.graphicsDevice !== null)).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
});
