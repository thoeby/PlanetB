// Story 37 — buying a product (PLAN-money.md MN.5, §2).
//
// C registers a product with a price. B finds it and buys it: C's wallet asks
// B's for the price, pressing Buy is B saying yes, and the licence is B's when
// the payment is in. C's wallet has the price more, and C is told who bought
// what.

import { join } from 'node:path';

import { test, expect, open, panel, signIn, UI } from './players.js';
import { REPO } from './world.js';

// A model no other story registers: the same bytes are the same product.
const GLB = join(REPO, 'client/test/fixtures/assets/rock.glb');
const PRODUCT = 'Saaser boulder';
const balance = (p) => p.page.locator('.wallet-balance .v');

test('story 37 — C sells a product, B buys it, and C is paid',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        await test.step('C registers a product at a price of 12', async () => {
            await panel(c, 'Catalog');
            await c.page.locator('#file').setInputFiles(GLB);
            await expect(c.page.locator('#canon')).toContainText('tris', { timeout: UI });
            await c.page.locator('#name').fill(PRODUCT);
            await c.page.locator('#upload-license').selectOption('paid');
            await c.page.locator('#price').fill('12');
            await c.page.locator('#publish').click();
            await expect(c.page.locator('#upload-status'))
                .toContainText(/registered|listed|SAN|[A-Z0-9]{4}/, { timeout: UI });
        });
        await panel(c, 'Wallet');
        const before = Number(await balance(c).textContent());
        await c.close();

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('B finds it and buys it', async () => {
            await panel(b, 'Catalog');
            await b.page.locator('#q').fill(PRODUCT);
            await b.page.locator('#q').press('Enter');
            await b.page.locator('#results').getByRole('button', { name: PRODUCT }).first()
                .click({ timeout: UI });
            await b.page.getByRole('button', { name: 'buy for 12.00' }).click();
            await expect(b.page.locator('#status')).toContainText('paying Cara 12.00',
                { timeout: UI });
        });

        await test.step('the licence is B’s when the payment is in', async () => {
            await expect.poll(async () => {
                await b.page.locator('#results').getByRole('button', { name: PRODUCT }).first()
                    .click();
                return b.page.locator('#detail .buy').textContent();
            }, { timeout: UI, intervals: [2000] }).toBe('you hold this');
            await panel(b, 'Wallet');
            await expect(b.page.locator('.wallet-history li', { hasText: PRODUCT }))
                .toContainText('−12.00', { timeout: UI });
        });
        await b.close();

        const c2 = await open(browser, world, 'C', testInfo);
        await test.step('C has 12 more, and is told who bought it', async () => {
            await signIn(c2, 'cara@visp.example', 'Cara');
            await panel(c2, 'Wallet');
            await expect(balance(c2)).toHaveText((before + 12).toFixed(2), { timeout: UI });
            await expect(c2.page.locator('#attention')).toHaveText(/[1-9]/, { timeout: UI });
            await c2.page.locator('#attention').click();
            await expect(c2.page.getByText(`Ben bought ${PRODUCT} for 12.00`).first())
                .toBeVisible({ timeout: UI });
        });
        await c2.close();
    });
