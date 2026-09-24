// Story 39 — failure, always: the issuer is away (PLAN-money.md MN.7).
//
// The issuer is stopped. B pays C 2: the wallet says, on the payment itself,
// that the issuer is not reachable and nothing has left the wallet — and
// nothing has. The issuer comes back, and the payment goes through by itself
// and says so; nobody pressed anything again.

import { test, expect, open, panel, signIn, UI } from './players.js';

const balance = (p) => p.page.locator('.wallet-balance .v');

test('story 39 — a payment made while the issuer is away goes through when it is back',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await panel(b, 'Wallet');
        await expect(balance(b)).toHaveText(/\d+\.\d\d/, { timeout: UI });
        const before = Number(await balance(b).textContent());

        const row = b.page.locator('.wallet-history li', { hasText: 'while it was away' });
        await test.step('the issuer is stopped, and B pays C 2', async () => {
            world.cash.stopIssuer();
            const form = b.page.locator('.wallet-pay');
            await form.getByLabel('pay to').fill('Cara');
            await form.getByLabel('amount').fill('2');
            await form.getByLabel('message').fill('while it was away');
            await form.getByRole('button', { name: 'Pay' }).click();
        });

        await test.step('the wallet says so, and nothing has left it', async () => {
            await expect(row).toContainText('The issuer is not reachable', { timeout: UI });
            await expect(row).toContainText('nothing has left the wallet');
            await expect(balance(b)).toHaveText(before.toFixed(2));
        });

        await test.step('the issuer is back, and it goes through by itself', async () => {
            world.cash.startIssuer();
            await expect(row).toContainText('Went through once the issuer was back',
                { timeout: 90_000 });
            await expect(balance(b)).toHaveText((before - 2).toFixed(2), { timeout: UI });
        });
        await b.close();
    });
