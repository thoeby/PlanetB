// Story 72 — the Marketplace (TASKS-ui.md UI.4–UI.6).
//
// C puts a boulder on sale in four steps — the model, its parts, its name and
// price, Register. B finds it in the Shop and takes two; they are his under
// Licences and on his Inventory's shelf. C sees the order under Selling and
// the month under Earnings. Nobody in this run has a credit (story 48), so the
// boulder is free and every sum is nothing; what a price does to a wallet is
// db/test's, and the money is about to be GNU Taler's anyway.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { fixture } from './things.js';
import { inTheShop, onSale, register, step } from './selling.js';

async function putsItOnSale(c) {
    await onSale(c);
    await c.page.locator('#upload-type').selectOption('model');
    await c.page.locator('#file').setInputFiles(fixture('rock.glb'));
    await expect(c.page.locator('#canon')).toContainText('tris', { timeout: UI });
    await expect(c.page.locator('#preview')).toBeVisible();
    await c.page.locator('#upload .rg-next').click();
    // The parts step shows the model too: marking is done by looking at it.
    await expect(c.page.locator('#preview')).toBeVisible();
    await c.page.locator('#upload .rg-next').click();
    await c.page.locator('#name').fill('Findling');
    await c.page.locator('#price').fill('0');
    await step(c, 'done');
    await expect(c.page.locator('#upload .rg-sum')).toContainText('Findling');
    await register(c);
    const said = c.page.locator('#upload-status');
    await expect(said).toContainText('published S', { timeout: UI });
    // Registered, it is the product Selling shows.
    await panel(c, 'Selling');
    await expect(c.page.locator('.mk-one h2')).toHaveText('Findling', { timeout: UI });
    return (await said.textContent()).match(/S[A-Z2-7]{12}/)[0];
}

async function takesTwo(b) {
    const card = await inTheShop(b, 'Findling');
    await expect(card).toContainText('Cara');
    await card.locator('.mk-name').click();
    const detail = b.page.locator('#detail');
    await expect(detail.locator('h2')).toHaveText('Findling', { timeout: UI });
    // The Market is drawn and not yet there.
    await expect(detail.getByRole('button', { name: 'Take the market offer' })).toBeDisabled();
    await detail.getByLabel('how many').fill('2');
    await detail.locator('button.buy').click();
    await expect(b.page.locator('#status')).toContainText('licensed S', { timeout: UI });
}

test('story 72 — a boulder is put on sale, and bought', async ({ browser, world }, testInfo) => {
    const c = await open(browser, world, 'C', testInfo);
    await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
    const san = await test.step('1 — C puts a boulder on sale in four steps',
        () => putsItOnSale(c));

    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    await test.step('2 — B finds it in the Shop and takes two', () => takesTwo(b));
    await test.step('3 — it is B’s, under Licences and on the Inventory shelf', async () => {
        await panel(b, 'Licences');
        await expect(b.page.locator(`.mk-licence[data-san="${san}"]`))
            .toContainText('Findling', { timeout: UI });
        await expect(b.page.locator(`.mk-licence[data-san="${san}"]`)
            .getByRole('button', { name: 'Resell' })).toBeDisabled();
        await panel(b, 'Inventory');
        await expect(b.page.locator(`.inv-card[data-san="${san}"]`))
            .toContainText('licence since', { timeout: UI });
    });
    await b.close();

    await test.step('4 — C sees the order under Selling, and the month under Earnings',
        async () => {
            await panel(c, 'Selling');
            await c.page.locator('.mk-products button', { hasText: 'Findling' }).click();
            const sold = c.page.locator('.mk-one .mk-stat')
                .filter({ has: c.page.locator('.label', { hasText: /^Sold$/ }) });
            await expect(sold.locator('b')).toHaveText('2', { timeout: UI });
            await expect(c.page.locator('.mk-table tbody tr').first()).toContainText('Ben');
            await expect(c.page.getByRole('button', { name: 'Take off sale' })).toBeDisabled();
            await panel(c, 'Earnings');
            await expect(c.page.locator('.mk-stat', { hasText: 'This month' })).toBeVisible();
            await expect(c.page.locator('.mk-stat')
                .filter({ has: c.page.locator('.label', { hasText: /^Resales$/ }) }))
                .toHaveAttribute('data-tone', 'off');
        });
    await c.close();
});
