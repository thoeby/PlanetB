// Story 10 — build grants (docs/SPEC.md §3.11).
//
// C stands on B's land and asks to build there, saying what for. B is told,
// sees the ask on the land's own card, and gives it. C is told, and the Place
// panel — which said whose land it was and that they could not — lets them
// build. B submits what C built and approves it.
//
// Who put an object down is not recorded anywhere (PLAYER-RUN.md, Blocked):
// either somebody may build on that ground or they may not.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// B's land, found the way a player finds it: stand on it and read the line.
async function bensLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await b.page.locator('#standing .coords').textContent());
}

async function cAsks(c, here) {
    await c.page.goto(`${c.world.pageUrl}#at=${here.lat},${here.lon},0,0`);
    await looking(c);
    await expect(c.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await panel(c, 'Place');
    // The sentence names the land and the person, and says what to do about
    // it (SPEC §3.4, client/js/buildui.js).
    await expect(c.page.locator('.build-where'))
        .toContainText('you may not build here', { timeout: UI });
    await expect(c.page.locator('.build-where'))
        .toContainText('Ask them for a build grant');
    await panel(c, 'Your land');
    const card = c.page.locator('.land-under');
    await expect(card).toContainText('Ben’s field', { timeout: UI });
    await expect(card).toContainText('Ben owns it');
    await card.locator('.ask-note').fill('a bench by the path');
    await card.locator('.ask-send').click();
    await expect(card.locator('.ask-status')).toContainText('asked', { timeout: UI });
}

test('story 10 — C asks to build on B’s land, and B says yes',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        const c = await open(browser, world, 'C', testInfo);
        b.world = world;
        c.world = world;
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        const here = await test.step('B goes to their land', () => bensLand(b));
        await test.step('C stands there and asks to build', () => cAsks(c, here));

        await test.step('B is told, and the ask is on the land’s card', async () => {
            await expect(b.page.locator('#attention')).toHaveText(/[1-9]/,
                { timeout: UI });
            await panel(b, 'Your land');
            const asks = b.page.locator('.land-asks');
            await expect(asks).toContainText('Cara', { timeout: UI });
            await expect(asks).toContainText('a bench by the path');
        });

        await test.step('B gives it', async () => {
            await b.page.locator('.ask-give').first().click();
            await expect(b.page.locator('.land-status'))
                .toContainText('may build', { timeout: UI });
        });

        await test.step('C is told, and may build there now', async () => {
            await expect(c.page.locator('#attention')).toHaveText(/[1-9]/,
                { timeout: UI });
            await panel(c, 'Place');
            // "building on Ben's field" is the panel saying they may.
            await expect(c.page.locator('.build-where'))
                .toContainText('building on Ben’s field', { timeout: UI });
        });

        await test.step('C builds on it', async () => {
            await c.page.locator('.build-toggle').check();
            const search = c.page.locator('.build-search');
            await search.fill('Valais bench');
            await search.dispatchEvent('change');
            await c.page.getByRole('button', { name: /Valais bench/ }).first().click();
            // Lower on the screen than the horizon: the ray that finds the
            // ground reaches four hundred metres (client/js/build.js), and
            // downhill at eye level that is not far enough to touch anything.
            await c.page.mouse.click(700, 620);
            await expect(c.page.locator('.build-sel'))
                .toContainText(/placing|selected|Move/i, { timeout: UI });
            await c.page.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(c.page.locator('.build-saved'))
                .toContainText('saved', { timeout: UI });
        });

        await test.step('and B submits it and says yes', async () => {
            await panel(b, 'Submit');
            await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
            await b.page.locator('.su-note').fill('Cara’s bench');
            await b.page.locator('.su-mine').click();
            await expect(b.page.locator('.su-status'))
                .toContainText('render job(s) are in the pool', { timeout: UI });
        });

        await b.close();
        await c.close();
    });
