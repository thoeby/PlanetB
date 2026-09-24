// Story 33 — a verified player holds a wallet (PLAN-money.md MN.0, MN.1).
//
// Every player who was verified in the stories before this one was given a
// wallet with the starting amount the moment they were: C in story 4, E in
// story 32. C opens the Wallet and reads the cash in it and where it came
// from; the bar along the top says the same number; the Inventory lists the
// wallet as a thing C holds. Nothing a player could do with credits is lost:
// the price on a job and buying a product are cash now (stories 36, 37).
//
// A, the admin, names the money first (O3, Admin → World): the bar writes
// what A called it.
//
// MN.0's switch — credits already in a ledger arriving as cash — has nothing
// to switch in a world that starts empty; db/test/0197 proves it.

import { test, expect, open, panel, shows, signIn, UI } from './players.js';

test('story 33 — C holds a wallet with the starting amount in it',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A names the money', async () => {
            await signIn(a, 'anna@visp.example', 'Anna');
            await panel(a, 'Cash');
            await shows(a, "The issuer's currency is PLANETB");
            await expect(a.page.getByLabel('starting amount')).toHaveValue('100');
            await a.page.getByLabel('currency name').fill('Taler of Visp');
            await a.page.getByLabel('currency symbol').fill('VT');
            await a.page.getByRole('button', { name: 'Save' }).click();
            await shows(a, 'Saved.');
        });
        await a.close();
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        await test.step('the Wallet says what is in it', async () => {
            await panel(c, 'Wallet');
            await expect(c.page.locator('.wallet-balance .v')).toHaveText('100.00',
                { timeout: UI });
            await expect(c.page.locator('.wallet-history li').first())
                .toContainText('the world', { timeout: UI });
            await expect(c.page.locator('.wallet-history li').first())
                .toContainText('the starting amount');
            await expect(c.page.locator('.wallet-history li').first()).toContainText('+100.00');
        });

        await test.step('the bar says it too', async () => {
            await expect(c.page.locator('#top .credits')).toContainText('100.00');
            await expect(c.page.locator('#top .credits')).toContainText('VT');
        });

        await test.step('and the Inventory holds it', async () => {
            await panel(c, 'Inventory');
            await expect(c.page.locator('.inv-held')).toHaveCount(1, { timeout: UI });
            await expect(c.page.locator('.inv-held')).toContainText('Wallet 1');
            await shows(c, '100.00');
        });

        await c.close();
    });
