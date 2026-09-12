// The chrome the design fixes, in a real browser: the five-stage pipeline, the
// position line, the hotbar in four groups with a key each, one panel at a
// time, and the map in the corner.
//
// The page is served the same way the other viewer tests serve it, so nothing
// here needs an API: the chrome has to stand up against a world that answers
// nothing at all.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { install, testTileRows, CLIENT } from './serve.js';

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
});

async function boot(page) {
    await install(page, rows);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/play.html');
    await page.waitForFunction(() => window.splatworld?.hud, null, { timeout: 60000 });
    return errors;
}

test('the stylesheet is actually applied', async ({ page }) => {
    const errors = await boot(page);
    // A browser refuses a stylesheet served with the wrong media type and the
    // page then renders, complete and unstyled, with every text assertion
    // below still passing. This is the one that notices.
    const brand = await page.evaluate(() => {
        const b = document.querySelector('#brand');
        const s = window.getComputedStyle(b);
        return { position: s.position, family: s.fontFamily, sheets: document.styleSheets.length };
    });
    expect(brand.position).toBe('absolute');
    expect(brand.family).toMatch(/Rajdhani|Sora|Oswald|sans-serif/);
    expect(brand.sheets).toBeGreaterThan(0);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('the chrome says where you are and what the world is doing', async ({ page }) => {
    const errors = await boot(page);

    await expect(page.locator('#brand .mark')).toHaveText('splatworld');
    await expect(page.locator('#brand .who')).toHaveText('not signed in');

    // Five stages, in the order the design fixes, and credits beside them.
    await expect(page.locator('#pipeline .stage .label')).toHaveText([
        'Placed', 'In pool', 'Rendered', 'Awaiting', 'Published',
    ]);
    await expect(page.locator('#credits .label')).toHaveText('Credits');

    // Where you are: the land, the right, the coordinates, a compass.
    await expect(page.locator('#land')).toHaveText(/\w/);
    await expect(page.locator('#standing .coords')).toHaveText(/[0-9.]+[NS] [0-9.]+[EW]/);
    await expect(page.locator('#compass .needle')).toBeVisible();

    // Eleven ways in, grouped as the design groups them, each with its key.
    await expect(page.locator('.hotgroup > .name')).toHaveText([
        'Look', 'Build', 'Economy', 'System',
    ]);
    await expect(page.locator('#tabs .tab')).toHaveCount(11);
    await expect(page.locator('#tabs .tab .key').first()).toHaveText('1');

    // The map, and the legend's four states.
    await expect(page.locator('#minimap')).toBeVisible();
    await expect(page.locator('#legend span')).toHaveCount(4);

    expect(errors, errors.join('\n')).toEqual([]);
});

test('a number key opens its panel, and Escape closes it', async ({ page }) => {
    const errors = await boot(page);
    const panel = page.locator('#panel');

    for (const [key, name] of [['2', 'Your land'], ['4', 'Catalog'],
        ['7', 'Permission'], ['9', 'Share'], ['`', 'Setup']]) {
        await page.keyboard.press(key);
        await expect(panel, `${name} did not open on ${key}`).toBeVisible();
        await expect(panel.locator('header .title')).toHaveText(name);
        await expect(page.locator(`#tabs .tab[data-tab="${name}"]`))
            .toHaveAttribute('aria-selected', 'true');
        // One panel at a time: only the chosen tab's body is shown.
        await expect(panel.locator('.tab-body:visible')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
    }

    // Each panel is as wide as the design makes it.
    await page.keyboard.press('4');
    const wide = await page.locator('#panel').evaluate((n) => n.getBoundingClientRect().width);
    await page.keyboard.press('Escape');
    await page.keyboard.press('8');
    const narrow = await page.locator('#panel').evaluate((n) => n.getBoundingClientRect().width);
    expect(wide).toBeGreaterThan(narrow);

    expect(errors, errors.join('\n')).toEqual([]);
});

test('a key typed into a field is text, not a teleport', async ({ page }) => {
    const errors = await boot(page);
    // Setup, which has fields. A world with no ground opens on Setup by
    // itself, and `show` is a toggle, so make sure rather than press.
    await page.evaluate(() => {
        const { hud } = window.splatworld;
        if (hud.opened() !== 'Setup') hud.show('Setup');
    });
    const field = page.locator('#panel input.gs-url');
    await field.waitFor();
    await field.click();
    await field.fill('4');
    // The key did not open a panel, and the character reached the field.
    await expect(page.locator('#panel header .title')).toHaveText('Setup');
    await expect(field).toHaveValue('4');
    expect(errors, errors.join('\n')).toEqual([]);
});
