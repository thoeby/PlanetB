// Story 48 — a land's files, kept by somebody's tab for a term (TASKS-live.md
// LV.13).
//
// B offers his field to be hosted for three minutes. C hosts it from her tab: it
// fetches every file the field names and holds them. A comes by the gate with
// the world's store out of her reach and gets the gate from Cara's tab, which
// the world counts. After the three minutes C settles for the share of the field's
// bytes she served. Nobody in this run has earned a credit (nothing is
// rendered: PROGRESS.md), so the bounty is nothing and so is the pay; what a
// bounty is split into is db/test/0214's.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { GATE_AT, goesToTheLand, sees, stands } from './things.js';

const START = { north: GATE_AT.north - 0.00018, east: GATE_AT.east };

// The balance on the bar, after the wallet has asked again.
async function credits(p) {
    await p.page.evaluate(() => window.splatworld.wallet.refresh());
    const text = await p.page.getByRole('button', { name: /^[\d.]+CR$/ }).textContent();
    return Number(text.replace(/[^\d.]/g, ''));
}

async function offersHisField(b) {
    await panel(b, 'Hosting');
    const form = b.page.locator('.host-form');
    await expect(form).toBeVisible({ timeout: UI });
    await form.getByLabel('land to host').selectOption({ label: 'Ben’s field' });
    await form.getByLabel('minutes to host it').fill('3');
    await form.getByLabel('bounty').fill('0');
    await form.getByRole('button', { name: 'Offer' }).click();
    await expect(b.page.locator('.hosting-said'))
        .toContainText('Ben’s field is offered to be hosted for 3 min.', { timeout: UI });
}

async function hostsIt(c) {
    await panel(c, 'Hosting');
    const row = c.page.locator('li.duty.host', { hasText: 'Ben’s field' }).first();
    await expect(row.getByRole('button', { name: 'Host' })).toBeEnabled({ timeout: UI });
    await row.getByRole('button', { name: 'Host' }).click();
    await expect(c.page.locator('.hosting-said'))
        .toContainText(/Hosting \d+ file\(s\) of Ben’s field until/, { timeout: UI });
    return c.page.evaluate(() => [...window.splatworld.peers.held]);
}

test('story 48 — C hosts B\'s field for three minutes, and settles for what she served',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        // Where his field is, which is what B would tell anybody (SPEC §3.8).
        const here = await goesToTheLand(b);
        await test.step('B offers his field to be hosted for three minutes',
            () => offersHisField(b));
        await b.page.close({ runBeforeUnload: true });
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await expect.poll(() => c.page.evaluate(() => Boolean(window.splatworld.peers.id)),
            { timeout: UI }).toBe(true);
        const held = await test.step('1 — C hosts it: her tab fetches every file the field names',
            () => hostsIt(c));
        expect(held.length, 'the field\'s files are in her tab').toBeGreaterThan(0);
        const before = await credits(c);

        const a = await open(browser, world, 'A', testInfo);
        await a.context.route(/\/(assets|ipfs)\//, (route) => route.abort('connectionrefused'));
        await test.step('2 — A comes by the gate without the store, and gets it from Cara',
            async () => {
                await signIn(a, 'anna@visp.example', 'Anna');
                await stands(a, world, here, START.north, START.east);
                await looking(a);
                const gate = await expect.poll(() => a.page.evaluate(() =>
                    [...window.splatworld.preview.rows.values()]
                        .find((r) => r.name === 'Schranke')?.id ?? null), { timeout: UI })
                    .not.toBeNull().then(() => a.page.evaluate(() =>
                        [...window.splatworld.preview.rows.values()]
                            .find((r) => r.name === 'Schranke').id));
                await sees(a, gate).toBe(true);
                const from = await a.page.evaluate(() =>
                    [...window.splatworld.peers.from.values()]);
                expect(from, 'the gate came from Cara\'s tab').toContain('Cara');
            });
        await a.close();

        await test.step('3 — after the three minutes C settles for the share she served',
            async () => {
                await panel(c, 'Hosting');
                const row = c.page.locator('li.duty.host', { hasText: 'Ben’s field' }).first();
                await expect.poll(async () => {
                    await c.page.evaluate(() => window.splatworld.hosting.refresh());
                    return row.textContent();
                }, { timeout: UI }).toMatch(/served [1-9]/);
                await expect.poll(async () => {
                    await c.page.evaluate(() => window.splatworld.hosting.refresh());
                    return row.getByRole('button', { name: 'Settle' }).count();
                }, { timeout: 240_000, intervals: [5000] }).toBe(1);
                await row.getByRole('button', { name: 'Settle' }).click();
                await expect(c.page.locator('.hosting-said'))
                    .toContainText(/settled: 0\.00 cr for [1-9]\d*% of its bytes served/,
                        { timeout: UI });
                expect(await credits(c), 'a bounty of nothing pays nothing').toBe(before);
            });
        await c.close();
    });
