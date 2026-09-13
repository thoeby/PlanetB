// Story 13 — failure and recovery (docs/SPEC.md §3.12).
//
// Two things go wrong and the world carries on.
//
// The elevation service is stopped while somebody is standing in the world:
// the page says so where they are, in the words the server used, and keeps
// working — the panels still open and the position line still moves. It is
// started again and the ground comes back by itself, with nobody reloading
// anything.
//
// And a render somebody walked away from goes back into the pool: C takes a
// job, their tab closes mid-compile, and B finds the same job waiting with the
// sentence that says what happened to it.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';

const NOTICE = '#notice';

// A job somebody can take: after story 12 published a tile, the coarse tiles
// above it are being rebuilt, and those are in the pool at no price.
async function takesAJob(c) {
    await panel(c, 'Work');
    const row = c.page.locator('.po-list li').filter({ hasText: 'free' }).first();
    await expect(row).toBeVisible({ timeout: UI });
    const which = await row.locator('.name').textContent();
    await row.getByRole('button', { name: 'Render' }).click();
    await expect(c.page.locator('.po-status'))
        .toContainText(/assembling|sampling|merging|encoding|framing/, { timeout: UI });
    return which.trim();
}

async function findsItBack(b, which) {
    await looking(b);
    await panel(b, 'Work');
    const row = b.page.locator('.po-list li').filter({ hasText: which });
    await expect(row.first()).toBeVisible({ timeout: UI });
    await expect(row.first()).toContainText('handed back', { timeout: UI });
    await expect(row.first()).toContainText('went away');
    // And it is work again, not a row with nothing to press.
    await expect(row.first().getByRole('button', { name: 'Render' })).toBeVisible();
}

test('story 13 — the world says what went wrong, and carries on',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        const c = await open(browser, world, 'C', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        // ------------------------------------------------- a render abandoned
        const which = await test.step('C takes a job out of the pool',
            () => takesAJob(c));

        // The tab, not the whole browser: closing a page is what a person
        // does, and it is the page that has something to say on its way out.
        await test.step('C’s tab goes away mid-compile', () => c.page.close());

        await test.step('and B finds it back in the pool, with the sentence',
            () => findsItBack(b, which));

        // ------------------------------------- the elevation service goes away
        await test.step('the elevation service is stopped', async () => {
            world.geoserver.stop();
            // Ground nobody has cut yet: the stories before this one have
            // walked over every tile of a four-kilometre DEM, and ground
            // already cut is served off the disk without asking anybody.
            world.forgetGround();
        });

        // Somebody who has not been here before: a tab that has already been
        // shown this ground has it in its own cache, and a page that asks for
        // nothing cannot be told that the answer failed.
        const a = await open(browser, world, 'A', testInfo);

        await test.step('the page says so, where they are standing', async () => {
            await expect(a.page.locator(NOTICE))
                .toContainText('elevation service is not answering', { timeout: UI });
        });

        await test.step('and the page keeps working while it is gone',
            async () => {
                await expect(a.page.locator(NOTICE))
                    .toContainText('Trying again', { timeout: UI });
                // The rest of it is still there: panels open, and the position
                // line under the crosshair still says where you are.
                await panel(a, 'Setup');
                await expect(a.page.locator('#standing .coords'))
                    .toContainText(/[NS]/, { timeout: UI });
            });

        await test.step('it is started again, and the ground comes back by itself',
            async () => {
                await world.geoserver.start();
                await expect(a.page.locator(NOTICE))
                    .not.toContainText('elevation service', { timeout: UI });
            });

        await a.close();
        await b.close();
        await c.close();
    });
