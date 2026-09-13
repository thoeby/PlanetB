// Story 5 — building (docs/SPEC.md §3.4).
//
// B goes to their land, turns on build mode, picks the product C registered,
// puts two down, moves one, and saves. C, standing in the same place, sees
// them within half a minute, marked "not yet rendered" — saved objects are
// everybody's to see (SPEC §0.3). B undoes one and saves again, and C sees
// one. Off B's land, the Build control says why it will not.

import { test, expect, open, panel, signIn, UI } from './players.js';

const PRODUCT = 'Valais bench';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

async function goToMyLand(player) {
    await panel(player, 'Your land');
    await player.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(player.page.locator('#land')).toHaveText('Ben’s field',
        { timeout: UI });
    return readCoords(await player.page.locator('#standing .coords').textContent());
}

// The player's own view is 1280 x 800; the middle of it is the ground in front
// of them. Two clicks a little apart put two benches down.
const SPOTS = [{ x: 620, y: 520 }, { x: 700, y: 540 }];

async function buildTwo(b) {
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.build-search');
    await search.fill(PRODUCT);
    await search.dispatchEvent('change');
    await b.page.getByRole('button', { name: new RegExp(PRODUCT) }).first().click();
    for (const at of SPOTS) await b.page.mouse.click(at.x, at.y);
    await expect(b.page.locator('.build-sel')).toContainText(/placing|selected|Move/i,
        { timeout: UI });
}

test('story 5 — B builds on their land, and C sees it', async ({ browser, world },
    testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    const c = await open(browser, world, 'C', testInfo);
    await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
    await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

    const here = await test.step('B goes to their land', () => goToMyLand(b));

    await test.step('the page says which key builds', async () => {
        await expect(b.page.locator('#tabs button[data-tab="Place"]'))
            .toContainText('3');
    });

    await test.step('B picks C’s product and puts two down', () => buildTwo(b));

    await test.step('C sees nothing yet: they are still being placed', async () => {
        await expect(c.page.locator('.world-label[data-tone="warn"]'))
            .toHaveCount(0);
    });

    await test.step('B moves one, and saves', async () => {
        await b.page.getByRole('button', { name: 'Move' }).click();
        await b.page.getByRole('button', { name: '+', exact: true }).click();
        await b.page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(b.page.locator('.build-saved'))
            .toContainText('2 objects saved', { timeout: UI });
        await expect(b.page.locator('.build-saved')).toContainText('tile');
    });

    await test.step('C, standing there, sees them marked unrendered', async () => {
        await c.page.goto(`${world.pageUrl}#at=${here.lat},${here.lon},0,0`);
        await expect(c.page.locator('.world-label[data-tone="warn"]'))
            .toHaveCount(2, { timeout: UI });
        await expect(c.page.locator('.world-label[data-tone="warn"]').first())
            .toHaveText('not yet rendered');
    });

    await test.step('B undoes one and saves, and C sees one', async () => {
        await b.page.getByRole('button', { name: 'Undo' }).click();
        await b.page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(c.page.locator('.world-label[data-tone="warn"]'))
            .toHaveCount(1, { timeout: UI });
    });

    await test.step('off B’s land, the Build control says why not', async () => {
        await b.page.locator('.build-toggle').uncheck();
        await b.page.goto(`${world.pageUrl}#at=46.2800,7.8600,0,0`);
        await panel(b, 'Place');
        await expect(b.page.locator('.build-where'))
            .toContainText(/may not build|nobody owns|not your land/i, { timeout: UI });
    });

    await b.close();
    await c.close();
});
