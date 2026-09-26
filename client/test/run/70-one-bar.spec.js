// Story 70 — one bar at the top, and a quieter Build (TASKS-ui.md UI.1, UI.2).
//
// B stands on his field. The bar has no wordmark; where he stands is in the
// middle of it. The views are glyphs on the bar while there is room and cards
// in the drawer when there is not — never both. Work's tabs are up in the bar
// and its panel has no title. Build has no "Next on" card and no legend; the
// altimeter is in the map, and the key hints fold to one line.

import { test, expect, open, panelApp, signIn, UI } from './players.js';
import { goesToTheLand } from './things.js';

// Exactly one of the two ways to the views is on screen.
async function viewsAre(b, where) {
    const glyphs = b.page.locator('#top .top-apps');
    const drawer = b.page.locator('#apps-btn');
    if (where === 'bar') {
        await expect(glyphs).toBeVisible({ timeout: UI });
        await expect(drawer).toBeHidden();
    } else {
        await expect(drawer).toBeVisible({ timeout: UI });
        await expect(glyphs).toBeHidden();
    }
}

test('story 70 — one bar, and Build without the clutter', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in and stands on his field', async () => {
        await signIn(b, 'ben@visp.example', 'Ben');
        await goesToTheLand(b);
    });

    await test.step('1 — no wordmark; the land line is the middle of the bar', async () => {
        await expect(b.page.locator('#top')).not.toContainText('SPLATWORLD');
        await expect(b.page.locator('#top #where #land')).toHaveText('Ben’s field');
        await expect(b.page.locator('#top #compass')).toBeVisible();
    });

    await test.step('2 — the views are glyphs while there is room, the drawer when not',
        async () => {
            await b.page.setViewportSize({ width: 1600, height: 800 });
            await viewsAre(b, 'bar');
            await b.page.setViewportSize({ width: 900, height: 800 });
            await viewsAre(b, 'drawer');
            await b.page.setViewportSize({ width: 1600, height: 800 });
            await viewsAre(b, 'bar');
        });

    await test.step('3 — Build: no Next-on card, no legend, the altimeter in the map',
        async () => {
            await expect(b.page.locator('#next')).toHaveCount(0);
            await expect(b.page.locator('#legend')).toHaveCount(0);
            await expect(b.page.locator('#map #alt')).toBeVisible();
        });

    await test.step('4 — the key hints are one line, and open on a press', async () => {
        const hints = b.page.locator('#hints');
        await expect(hints.locator('.keys')).toBeHidden();
        await expect(hints.locator('.short')).toContainText('W A S D');
        await hints.getByRole('button', { name: 'all keys' }).click();
        await expect(hints.locator('.keys')).toBeVisible();
        await hints.getByRole('button', { name: 'fewer keys' }).click();
        await expect(hints.locator('.keys')).toBeHidden();
    });

    await test.step('5 — Work’s tabs are in the bar, and its panel has no title', async () => {
        await panelApp(b, 'Work');
        await expect(b.page.locator('#top .parts button[data-tab="Hosting"]'))
            .toBeVisible({ timeout: UI });
        await expect(b.page.locator('#panel header')).toBeHidden();
        await expect(b.page.locator('#top #where')).toHaveCount(0);
        await panelApp(b, 'Build');
        await expect(b.page.locator('#top #where #land')).toBeVisible({ timeout: UI });
    });
    await b.close();
});
