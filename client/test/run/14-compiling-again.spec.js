// Compiling ground again (db/0081_compileitagain.sql).
//
// Not one of SPEC §3's stories: this is the thing the operator could not do —
// the world's recipe moves (a rule, a trainer with a new version) and the tiles
// do not, because nothing about the land changed. B asks for their land to be
// built again, and it goes through Submit and an approval like anything else.
//
// Here the recipe has not moved — this run built the tile minutes ago with the
// versions it still has — so what comes back is the same bytes, published
// again. That is the same door, and the page says so.

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
            // What comes back depends on whether the recipe moved. A job at a
            // new version owns the pieces the old one made (db/0100), so when
            // nothing about how a tile is built has changed, the same bytes
            // are still the answer and the tile publishes again at once: "0
            // render job(s) in the pool, 1 already published". When an
            // algo_version or a rule has moved, the pieces no longer match and
            // there is work. Either way it went through Submit and an approval
            // like anything else, and the page says which happened.
            await expect(b.page.locator('.su-status'))
                .toContainText(/\d+ render job\(s\) in the pool/, { timeout: UI });
            await expect(b.page.locator('.su-status'))
                .toContainText(/[1-9]\d* tile\(s\) approved/, { timeout: UI });
        });

        await test.step('a tile that was already published is in the pool again',
            async () => {
                await looking(c);
                await panel(c, 'Work');
                const rows = c.page.locator('.po-list li');
                await expect(rows.first()).toBeVisible({ timeout: UI });
                await expect(rows.filter({ hasText: 'trained' }).first())
                    .toBeVisible({ timeout: UI });
            });

        await b.close();
        await c.close();
    });
