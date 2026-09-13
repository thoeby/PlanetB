// Compiling ground again (db/0081_compileitagain.sql).
//
// Not one of SPEC §3's stories: this is the thing the operator could not do —
// the world's recipe moves (a rule, a sampler with a new version) and the tiles
// do not, because nothing about the land changed. B asks for their land to be
// built again, and it goes through Submit and an approval like anything else.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';

async function standsOnIt(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
}

test('ground already rendered can be asked for again',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        const c = await open(browser, world, 'C', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        await test.step('B stands on their land', () => standsOnIt(b));

        await test.step('B asks for all of it to be built again', async () => {
            await b.page.locator('.land-again').click();
            await expect(b.page.locator('.land-again-status'))
                .toContainText(/[1-9]\d* tile\(s\) to build again/, { timeout: UI });
        });

        await test.step('the card says the ground is changed again', async () => {
            await expect(b.page.locator('.land-changed'))
                .toContainText(/\d+ tiles? changed/, { timeout: UI });
        });

        await test.step('and it goes through Submit like anything else', async () => {
            await panel(b, 'Submit');
            await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
            await b.page.locator('.su-note').fill('built with the new sky');
            await b.page.locator('.su-mine').click();
            await expect(b.page.locator('.su-status'))
                .toContainText(/[1-9]\d* render job\(s\) are in the pool/,
                    { timeout: UI });
        });

        await test.step('a tile that was already published is in the pool again',
            async () => {
                await looking(c);
                await panel(c, 'Render pool');
                const rows = c.page.locator('.po-list li');
                await expect(rows.first()).toBeVisible({ timeout: UI });
                await expect(rows.filter({ hasText: 'assembled' }).first())
                    .toBeVisible({ timeout: UI });
            });

        await b.close();
        await c.close();
    });
