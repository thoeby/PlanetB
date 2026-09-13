// Story 9 — visiting and sharing (docs/SPEC.md §3.8).
//
// B copies the link to where they are standing. A, in a context that has never
// been there, opens it and is standing in the same place facing the same way,
// and the page says whose land it is. Then A finds the same land by name,
// without a link, and goes there. And a link to somewhere outside the coverage
// arrives at the nearest ground with a sentence rather than at nothing.

import { test, expect, open, panel, signIn, UI } from './players.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const metresBetween = (a, b) => Math.hypot(
    (a.lat - b.lat) * 111_320,
    (a.lon - b.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180));

// "46.2939N 7.8815E · 651 m" — where the page says the player is.
const whereIs = async (player) =>
    readCoords(await player.page.locator('#standing .coords').textContent());

// SPEC §3.8 step 3: Map -> search -> her land -> Go. A link is not the only way
// to a place; a name is the other one.
async function byName(a) {
    await test.step('A finds the land by its owner’s name and goes there',
        async () => {
            await a.page.locator('.map-find').fill('Ben');
            await a.page.locator('.map-find').dispatchEvent('change');
            const found = a.page.locator('.map-found li');
            await expect(found.first()).toContainText('Ben’s field',
                { timeout: UI });
            await found.first().getByRole('button', { name: 'Go' }).click();
            await expect(a.page.locator('#land')).toHaveText('Ben’s field',
                { timeout: UI });
        });
}

// And the failure §3.8 names: a place off the edge of the world.
async function offTheEdge(a, world) {
    await test.step('a link to nowhere arrives at the nearest ground', async () => {
        await a.page.goto(`${world.pageUrl}#at=46.2939,9.5000,0,0`);
        await expect(a.page.locator('#notice'))
            .toContainText('off the edge of the world', { timeout: UI });
        const arrived = await whereIs(a);
        expect(arrived.lon, 'brought back inside the coverage').toBeLessThan(9);
    });
}

test('story 9 — a link is a place, and a name finds one',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        await test.step('B stands on their land', async () => {
            await panel(b, 'Your land');
            await b.page.getByRole('button', { name: 'Go there' }).first().click();
            await expect(b.page.locator('#land')).toHaveText('Ben’s field',
                { timeout: UI });
        });

        const link = await test.step('B copies the link to here', async () => {
            await panel(b, 'Share');
            const field = b.page.locator('.sh-link');
            await expect(field).toHaveValue(/#at=[-\d.]+,[-\d.]+/, { timeout: UI });
            // What they will find, before they send it: the place and the way
            // they will be facing (SPEC §2.10).
            await expect(b.page.locator('.sh-facts')).toContainText('Position');
            await expect(b.page.locator('.sh-facts')).toContainText('Looking');
            await b.page.locator('.sh-copy').click();
            await expect(b.page.locator('.sh-status')).toContainText(/copied|select/,
                { timeout: UI });
            return field.inputValue();
        });
        const there = await whereIs(b);
        expect(there).not.toBeNull();

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A opens it and is standing where B was', async () => {
            await a.page.goto(link);
            await expect(a.page.locator('#land')).toHaveText('Ben’s field',
                { timeout: UI });
            const arrived = await whereIs(a);
            expect(metresBetween(arrived, there),
                'within a step of where the link points').toBeLessThan(30);
        });

        await test.step('A walks off it, and the page says so', async () => {
            await a.page.goto(`${world.pageUrl}#at=46.2760,7.8560,0,0`);
            await expect(a.page.locator('#land')).not.toHaveText('Ben’s field',
                { timeout: UI });
        });

        await byName(a);
        await offTheEdge(a, world);

        await a.close();
        await b.close();
    });
