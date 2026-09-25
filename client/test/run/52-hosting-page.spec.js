// Story 52 — Work › Hosting says what it is before it asks anything
// (TASKS-ui.md UI.7).
//
// B reads what hosting is — three steps — sees what his field holds before he
// offers it, and offers it from the card. C finds the offer as a card that
// says the land, its files, the term and the bounty, hosts it, and her own
// card says what her tab now holds.

import { test, expect, open, panel, signIn, UI } from './players.js';

async function offersFromTheCard(b) {
    await panel(b, 'Hosting');
    const intro = b.page.locator('.hs-intro');
    await expect(intro).toContainText('Hosting pays', { timeout: UI });
    await expect(intro.locator('.hs-steps li')).toHaveText([/Offer/, /Host/, /Settle/]);
    const form = b.page.locator('.host-form');
    await form.getByLabel('land to host').selectOption({ label: 'Ben’s field' });
    await expect(form.locator('.hs-holds'))
        .toHaveText(/[1-9]\d* file\(s\) · [\d.]+ MB would be hosted/, { timeout: UI });
    await form.getByLabel('minutes to host it').fill('2');
    await form.getByLabel('bounty').fill('0');
    await form.getByRole('button', { name: 'Offer' }).click();
    await expect(b.page.locator('.hosting-said'))
        .toContainText('Ben’s field is offered to be hosted for 2 min.', { timeout: UI });
}

async function hostsFromTheCard(c) {
    await panel(c, 'Hosting');
    await expect.poll(() => c.page.evaluate(() => Boolean(window.splatworld.peers.id)),
        { timeout: UI }).toBe(true);
    await c.page.evaluate(() => window.splatworld.hosting.refresh());
    const card = c.page.locator('li.hs-card', { hasText: 'Ben’s field' })
        .filter({ has: c.page.getByRole('button', { name: 'Host' }) }).first();
    await expect(card).toContainText(/\d+ file\(s\) · [\d.]+ MB · offered by Ben/,
        { timeout: UI });
    await expect(card).toContainText('0.00 cr');
    await card.getByRole('button', { name: 'Host' }).click();
    await expect(c.page.locator('.hosting-said'))
        .toContainText(/Hosting \d+ file\(s\) of Ben’s field until/, { timeout: UI });
    await c.page.evaluate(() => window.splatworld.hosting.refresh());
    await expect(c.page.locator('.hs-here')).toContainText(/A peer: holds [1-9]\d* file\(s\)/,
        { timeout: UI });
}

test('story 52 — hosting explains itself, and is done from cards',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('1 — B reads what hosting is, and offers his field',
            () => offersFromTheCard(b));
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('2 — C hosts it from its card, and her tab says what it holds',
            () => hostsFromTheCard(c));
        await c.close();
    });
