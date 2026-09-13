// Story 11 — deleting and redoing land (PLAYER-RUN.md story 11).
//
// B gives their land back from the Land panel. The page says what goes before
// it goes — the objects, the shapes drawn in QGIS, the published tiles — and
// asks once more. Then the land is gone from the panel, the ground where it
// stood belongs to nobody, and B asks for land again: story 2 repeats.

import { test, expect, looking, open, panel, shows, signIn, UI }
    from './players.js';

const pairs = (text) => text.trim().split('\n')
    .map((line) => line.split(',').map(Number));

async function standsOnIt(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
}

// A draws land for B again, on the map in the page, exactly as story 2 did:
// nothing about the second time round is a shortcut.
async function drawsTheBoundary(a) {
    const map = a.page.locator('#assign-map');
    await expect(map).toBeVisible({ timeout: UI });
    await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    for (const [fx, fy] of [[0.44, 0.44], [0.56, 0.44], [0.56, 0.56], [0.44, 0.56]]) {
        const p = at(fx, fy);
        await a.page.mouse.click(p.x, p.y);
    }
    await a.page.getByRole('button', { name: 'Finish the boundary' }).click();
    const drawn = await a.page.getByLabel('boundary').inputValue();
    expect(pairs(drawn).length, 'four corners came off the map')
        .toBeGreaterThanOrEqual(4);
    return drawn;
}

async function saysWhatGoes(b) {
    await b.page.locator('.land-back').click();
    const what = b.page.locator('.land-back-what');
    await expect(what).toBeVisible({ timeout: UI });
    await expect(what).toContainText('Ben’s field');
    // What stands on it and what is rendered on it are both named: story 5
    // placed objects here and story 8 published a tile.
    await expect(what).toContainText(/object/);
    await expect(what).toContainText('return');
    await expect(what).toContainText('ground');
}

async function givesItBack(b) {
    await b.page.locator('.land-back-no').click();
    await expect(b.page.locator('.land-back-what')).toHaveCount(0);
    await b.page.locator('.land-back').click();
    await b.page.locator('.land-back-yes').click();
    await shows(b, 'is gone');
}

async function asksAgain(b) {
    await panel(b, 'Your land');
    await b.page.getByLabel('what land do you want').fill('the same spot, please');
    await b.page.getByRole('button', { name: 'Request land' }).click();
    await shows(b, 'with the admin');
}

async function drawsAgain(a) {
    await looking(a);
    await panel(a, 'Admin');
    await shows(a, 'the same spot, please');
    const drawn = await drawsTheBoundary(a);
    await a.page.getByLabel('boundary').fill(drawn);
    await a.page.getByLabel('name this land').fill('Ben’s field');
    await a.page.getByRole('button', { name: 'Assign this land' }).click();
    await shows(a, 'assigned to Ben');
}

async function standsOnItAgain(b) {
    await looking(b);
    await panel(b, 'Your land');
    await shows(b, 'Ben’s field');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await shows(b, 'you may build here');
}

test('story 11 — B gives the land back, and asks for land again',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        const b = await open(browser, world, 'B', testInfo);
        await test.step('A signs in as the admin',
            () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        await test.step('B stands on their land', () => standsOnIt(b));

        await test.step('the page says what would go, before anything goes',
            () => saysWhatGoes(b));
        await test.step('B keeps it once, then gives it back', () => givesItBack(b));

        await test.step('the panel has no land in it any more', async () => {
            await panel(b, 'Your land');
            await shows(b, 'No land yet');
        });

        // B has not moved: they are standing where their land was. The line
        // under them has to stop naming land that no longer exists.
        await test.step('and the ground under B belongs to nobody', async () => {
            await expect(b.page.locator('#land')).toHaveText('unclaimed ground',
                { timeout: UI });
        });

        // Story 2, again, from the top.
        await test.step('B asks for land again', () => asksAgain(b));
        await test.step('A sees the request and draws it again', () => drawsAgain(a));
        await test.step('B stands on it again, with their name on it',
            () => standsOnItAgain(b));

        await a.close();
        await b.close();
    });
