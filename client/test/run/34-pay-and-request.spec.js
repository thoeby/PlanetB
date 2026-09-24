// Story 34 — a wallet pays, and asks to be paid (PLAN-money.md MN.2).
//
// A pays B 5 with a message: B's wallet has 5 more, and the message is shown
// with it. B asks A for 3: A sees the ask in their wallet, confirms it, and it
// is paid. And a payment the wallet cannot cover is refused in words, with
// nothing leaving it.

import { test, expect, open, panel, shows, signIn, UI } from './players.js';

const balance = (p) => p.page.locator('.wallet-balance .v');

async function fill(p, part, who, amount, note) {
    const form = p.page.locator(`.wallet-${part}`);
    await form.getByLabel(part === 'pay' ? 'pay to' : 'ask').fill(who);
    await form.getByLabel('amount').fill(String(amount));
    await form.getByLabel(part === 'pay' ? 'message' : 'what for').fill(note);
    await form.getByRole('button', { name: part === 'pay' ? 'Pay' : 'Request' }).click();
}

test('story 34 — A pays B, B asks A, and a payment too big says so',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const a = await open(browser, world, 'A', testInfo);
        const b = await open(browser, world, 'B', testInfo);
        await test.step('A signs in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await panel(a, 'Wallet');
        await panel(b, 'Wallet');
        await expect(balance(a)).toHaveText('100.00', { timeout: UI });
        await expect(balance(b)).toHaveText('100.00', { timeout: UI });

        await test.step('A pays B 5, with a message', async () => {
            await fill(a, 'pay', 'Ben', 5, 'for the bread');
            await shows(a, 'Paying Ben 5.00');
            await expect(balance(a)).toHaveText('95.00', { timeout: UI });
        });

        await test.step('B has 5 more, and reads why', async () => {
            await expect(balance(b)).toHaveText('105.00', { timeout: UI });
            const row = b.page.locator('.wallet-history li', { hasText: 'for the bread' });
            await expect(row).toContainText('Anna');
            await expect(row).toContainText('+5.00');
            await expect(b.page.locator('#attention')).toHaveText(/[1-9]/, { timeout: UI });
        });

        await test.step('B asks A for 3', async () => {
            await fill(b, 'request', 'Anna', 3, 'the rest');
            await shows(b, 'Asked Anna for 3.00');
        });

        await test.step('A sees the ask, and pays it', async () => {
            const ask = a.page.locator('.wallet-ask', { hasText: 'the rest' });
            await expect(ask).toContainText('Ben', { timeout: UI });
            await ask.getByRole('button', { name: 'Pay' }).click();
            await expect(balance(a)).toHaveText('92.00', { timeout: UI });
            await expect(balance(b)).toHaveText('108.00', { timeout: UI });
        });

        await test.step('a payment the wallet cannot cover says so', async () => {
            await fill(a, 'pay', 'Ben', 1000, 'too much');
            await shows(a, 'this wallet holds 92.00, not enough for 1000.00');
            await expect(balance(a)).toHaveText('92.00');
        });

        await a.close();
        await b.close();
    });
