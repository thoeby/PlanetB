// The chrome the design fixes, in a real browser: the strip along the top with
// the apps on it, the position line, the plinth of five surfaces with a key
// each, one panel at a time, the notifications, and the map in the corner.
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
    const bar = await page.evaluate(() => {
        const b = document.querySelector('#top');
        const s = window.getComputedStyle(b);
        return { position: s.position, height: s.height, family: s.fontFamily,
            sheets: document.styleSheets.length };
    });
    expect(bar.position).toBe('absolute');
    expect(bar.height).toBe('44px');
    expect(bar.family).toMatch(/Rajdhani|Sora|Oswald|sans-serif/);
    expect(bar.sheets).toBeGreaterThan(0);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('the chrome says where you are and what the world is doing', async ({ page }) => {
    const errors = await boot(page);

    await expect(page.locator('#top .mark')).toHaveText('splatworld');
    // Who you are is in the strip, on the chip that opens Profile.
    await expect(page.locator('#top .who .name')).toHaveText('Sign in');

    // The two numbers Build is played by, and nothing else about the route.
    await expect(page.locator('#top .num .caps')).toHaveText(['rendered', 'to decide']);

    // Six views, and only the one you are in is named.
    await expect(page.locator('#top .app-tab')).toHaveCount(6);
    await expect(page.locator('#top .app-tab[aria-selected="true"] .name'))
        .toHaveText('Build');

    // Where you are: the land, the right, the coordinates, a compass.
    await expect(page.locator('#land')).toHaveText(/\w/);
    await expect(page.locator('#standing .coords')).toHaveText(/[0-9.]+[NS] [0-9.]+[EW]/);
    await expect(page.locator('#compass .needle')).toBeVisible();
    // Ruled like the altimeter's ladder: a tick every 15°, tall where a point
    // is named. Eight letters is a label, not an instrument.
    await expect(page.locator('#compass .tick')).toHaveCount(24);

    // The plinth is the five surfaces the game is played through, on keys 1
    // to 5, and nothing else: you, your wallet and settings are in the strip.
    await expect(page.locator('#tabs .hotgroup')).toHaveCount(1);
    await expect(page.locator('#tabs .tab')).toHaveCount(5);
    await expect(page.locator('#tabs .tab .label'))
        .toHaveText(['Place', 'Catalog', 'Land', 'Publish', 'Work']);
    await expect(page.locator('#tabs .tab .key')).toHaveText(['1', '2', '3', '4', '5']);
    await expect(page.locator('#top button[data-tab]')).toHaveCount(3);

    // How high you are, and how far that is above the ground.
    await expect(page.locator('#alt .read .v')).toHaveText(/[\d,—]/);

    // Work is a surface with queues behind it: the machine strip above them,
    // and the five tabs of design 8 under it.
    await page.locator('#tabs .tab[data-tab="Work"]').click();
    await expect(page.locator('#panel .head #work .work-state')).toBeVisible();
    await expect(page.locator('#panel .parts .part:not([hidden])'))
        .toHaveText([/^All/, /^Render jobs/, /^Training/, /^Publish/, /^Settings/]);
    await page.locator('#panel .close').click();

    // The map, and the legend's four states.
    await expect(page.locator('#minimap')).toBeVisible();
    await expect(page.locator('#legend span')).toHaveCount(4);

    expect(errors, errors.join('\n')).toEqual([]);
});

test('a number key opens its panel, and Escape closes it', async ({ page }) => {
    const errors = await boot(page);
    const panel = page.locator('#panel');

    // A key opens the surface it names, or the surface that holds the part it
    // names — Share is a tab of Profile now, and Setup one of Settings.
    for (const [key, name, holder] of [['3', 'Your land'], ['2', 'Catalog'],
        ['4', 'Publish'], ['9', 'Profile', 'Profile'], ['`', 'Settings', 'Settings']]) {
        await page.keyboard.press(key);
        await expect(panel, `${name} did not open on ${key}`).toBeVisible();
        await expect(panel.locator('header .title')).toHaveText(name);
        await expect(page.locator(`:is(#tabs, #top) [data-tab="${holder ?? name}"]`))
            .toHaveAttribute('aria-selected', 'true');
        // One panel at a time: only the chosen tab's body is shown.
        await expect(panel.locator('.tab-body:visible')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
    }

    // Each panel is as wide as the design makes it.
    await page.keyboard.press('2');
    const wide = await page.locator('#panel').evaluate((n) => n.getBoundingClientRect().width);
    await page.keyboard.press('Escape');
    await page.keyboard.press('6');
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
    await field.fill('2');
    // The key did not open a panel, and the character reached the field.
    // Setup is a tab of Settings since v6, so the panel is titled for it.
    await expect(page.locator('#panel header .title')).toHaveText('Settings');
    await expect(field).toHaveValue('2');
    expect(errors, errors.join('\n')).toEqual([]);
});

// Every tab has an interior. The chrome was built before the panels were, and
// the failure mode then was a panel that opened onto its lede and nothing
// else — which looks like a broken page and reads like a missing feature.
test('every panel has something in it', async ({ page }) => {
    const errors = await boot(page);
    // Every body there is: a surface, or each part of one that has parts —
    // Publish holds Submit and Approve, Work its queues, Settings the account
    // and the two admin tools, Profile you and the link you hand out.
    const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#tabs .tab, #top button[data-tab]')]
            .flatMap((n) => n.dataset.parts?.split(',').filter(Boolean) ?? [n.dataset.tab]));
    // The strip comes first in the page, then the plinth.
    expect(tabs).toEqual(['Wallet', 'Profile', 'Share', 'Setup', 'Land',
        'Vocabulary', 'Place', 'Catalog', 'Your land',
        'Submit', 'Permission', 'Every job', 'Render jobs', 'Training',
        'Publishing', 'Machine']);
    // A world with no ground opens on Setup by itself, so close whatever is
    // docked before opening them one at a time.
    await page.evaluate(() => window.splatworld.hud.show('World'));
    await expect(page.locator('#panel')).toBeHidden();
    for (const name of tabs.filter((n) => n !== 'World')) {
        await page.evaluate((n) => window.splatworld.hud.show(n), name);
        const body = page.locator('#panel .tab-body:visible');
        await expect(body, `${name} opened onto nothing`)
            .not.toHaveText(/^\s*$/);
        const parts = await body.evaluate(
            (n) => n.querySelectorAll(':scope > *:not(.lede)').length);
        expect(parts, `${name} has only its lede`).toBeGreaterThan(0);
    }
    expect(errors, errors.join('\n')).toEqual([]);
});

// v6's two new things on the strip: the apps, which dress the chrome for a
// workspace without moving you, and the bell, where what happened while you
// were looking somewhere else waits.
test('Tab opens the apps, F-keys switch them, and Build is the one with panels',
    async ({ page }) => {
        const errors = await boot(page);
        const drawer = page.locator('#apps');
        await expect(drawer).toBeHidden();
        await page.keyboard.press('Tab');
        await expect(drawer).toBeVisible();
        await expect(drawer.locator('.app-card')).toHaveCount(6);
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();

        await page.keyboard.press('F6');
        await expect(page.locator('#top .app-tab[aria-selected="true"] .name'))
            .toHaveText('Survey');
        // An app is a workspace over the same world: the plinth and Build's own
        // numbers are gone, the world and the instruments are not.
        await expect(page.locator('#tabs')).toBeHidden();
        await expect(page.locator('#compass .needle')).toBeVisible();
        await expect(page.locator('#alt .ladder')).toBeVisible();
        await page.keyboard.press('F1');
        await expect(page.locator('#tabs')).toBeVisible();
        expect(errors, errors.join('\n')).toEqual([]);
    });

test('a notification lands under the bell and stays in the tray', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#tray')).toBeHidden();
    await page.evaluate(() => window.splatworld.hud.notify(
        { title: 'Render #4812 finished', meta: '2 tiles on Maloja Nord' }));
    await expect(page.locator('#toasts .toast .title')).toHaveText('Render #4812 finished');
    await expect(page.locator('#bell .count')).toHaveText('1');

    await page.locator('#bell').click();
    await expect(page.locator('#tray li .title')).toHaveText('Render #4812 finished');
    await page.locator('#tray .clear').click();
    await expect(page.locator('#tray li')).toHaveCount(0);
    await expect(page.locator('#bell .count')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#tray')).toBeHidden();
    expect(errors, errors.join('\n')).toEqual([]);
});
