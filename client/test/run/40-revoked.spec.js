// Story 40 — a verification revoked (PLAN-identity.md ID.5, V4).
//
// A revokes E's verification with a note. E reads the note; land says to
// verify first again, and so does E's wallet when E tries to pay from it —
// E still holds it (V4) and may hand it over, which E does, to B.

import { test, expect, open, panel, shows, signIn, UI } from './players.js';

test('story 40 — A revokes E, who keeps the wallet but cannot spend it',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        const e = await open(browser, world, 'E', testInfo);
        await test.step('A signs in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('E signs in', () => signIn(e, 'emil@visp.example', 'Emil'));

        await test.step('A revokes E, and says why', async () => {
            await panel(a, 'Players');
            const row = a.page.locator('.players-player', { hasText: 'Emil' });
            await row.getByLabel('note').fill('the call was somebody else');
            await row.getByRole('button', { name: 'Revoke' }).click();
            await shows(a, 'Emil is no longer verified');
            await expect(row).toContainText('revoked · the call was somebody else',
                { timeout: UI });
        });

        await test.step('E reads why', async () => {
            await panel(e, 'Verify');
            await expect(e.page.locator('.verify-state'))
                .toContainText('revoked: the call was somebody else', { timeout: UI });
        });

        await test.step('land says verify first again', async () => {
            await panel(e, 'Your land');
            await shows(e, 'Verify first');
        });

        await test.step('E holds the wallet, and paying from it says verify first',
            async () => {
                await panel(e, 'Wallet');
                await expect(e.page.locator('.wallet-balance .v')).toHaveText('100.00',
                    { timeout: UI });
                const form = e.page.locator('.wallet-pay');
                await form.getByLabel('pay to').fill('Ben');
                await form.getByLabel('amount').fill('1');
                await form.getByRole('button', { name: 'Pay' }).click();
                await expect(e.page.locator('.wallet-status')).toContainText('Verify first',
                    { timeout: UI });
                await expect(e.page.locator('.wallet-balance .v')).toHaveText('100.00');
            });

        await test.step('but may hand it over', async () => {
            await panel(e, 'Inventory');
            const it = e.page.locator('.inv-held').first();
            await it.getByLabel('hand it to').fill('Ben');
            await it.getByRole('button', { name: 'Hand over' }).click();
            await shows(e, 'Handing it to Ben');
        });

        await a.close();
        await e.close();
    });
