// Story 36 — a price on a render job is cash (PLAN-money.md MN.4, §2).
//
// B asks for his land to be built again and sends it (story 14's door), so
// there is work in the pool. He opens the first job there and puts 10 on it:
// it leaves his wallet and is held with the job, and the pool says so. B
// withdraws it before anybody has taken the job, and it comes back. Then B
// puts 10 on it again, C renders it, it publishes, and C's wallet has 10 more.
//
// The last step renders a tile, which on a software adapter does not finish
// (story 8 is the same); it is the part of this story that needs a GPU.

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';

const balance = (p) => p.page.locator('.wallet-balance .v');

async function opens(p, name) {
    await panel(p, 'Render jobs');
    const row = name ? p.page.locator('.po-list li').filter({ hasText: name }).first()
        : p.page.locator('.po-list li').first();
    await expect.poll(async () => {
        await p.page.evaluate(() => window.splatworld.pool.refresh());
        return row.count();
    }, { timeout: UI, intervals: [1000] }).toBeGreaterThan(0);
    const which = (await row.locator('.jc-title .name').textContent()).trim();
    await row.getByRole('button', { name: 'Details' }).click();
    return which;
}

// The pool is read when it is opened and after something is done to it, and
// the cash is held a moment after the press, when the wallet has done it: a
// player looks again, and so does this (story 8 the same).
async function prices(b, amount) {
    await b.page.getByLabel('price').fill(String(amount));
    await b.page.getByRole('button', { name: 'Put a price on it' }).click();
    await expect.poll(async () => {
        await b.page.evaluate(() => window.splatworld.pool.refresh());
        return b.page.locator('.jd-host:visible').textContent();
    }, { timeout: UI, intervals: [1000] }).toContain(`${amount}.00 held for it`);
}

async function sendsItAgain(b) {
    await test.step('B asks for his land to be built again, and sends it', async () => {
        await panel(b, 'Your land');
        await b.page.getByRole('button', { name: 'Go there' }).first().click();
        await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
        await b.page.getByRole('button', { name: 'Compile it all again' }).click();
        await expect(b.page.locator('.land-again-status'))
            .toContainText(/[1-9]\d* tile\(s\) to build again/, { timeout: UI });
        await panel(b, 'Submit');
        await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
        await b.page.locator('.su-note').fill('with a price on it');
        await b.page.locator('.su-mine').click();
        await expect(b.page.locator('.su-status'))
            .toContainText(/\d+ render job\(s\) in the pool/, { timeout: UI });
    });
}

async function cIsPaid(c, job) {
    await test.step('C renders it, it publishes, and C is paid', async () => {
        await signIn(c, 'cara@visp.example', 'Cara');
        await panel(c, 'Wallet');
        await expect(balance(c)).toHaveText(/\d+\.\d\d/, { timeout: UI });
        const before = Number(await balance(c).textContent());
        await panel(c, 'Render jobs');
        const row = c.page.locator('.po-list li').filter({ hasText: job }).first();
        await expect(row).toContainText('10.00', { timeout: UI });
        await row.getByRole('button', { name: 'Render' }).click();
        await expect(c.page.locator('.po-status')).toContainText('is published',
            { timeout: RENDER });
        await panel(c, 'Wallet');
        await expect(balance(c)).toHaveText((before + 10).toFixed(2), { timeout: UI });
    });
}

test('story 36 — B prices a job, withdraws it, and C is paid for rendering one',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await sendsItAgain(b);
        await panel(b, 'Wallet');
        await expect(balance(b)).toHaveText(/\d+\.\d\d/, { timeout: UI });
        const had = Number(await balance(b).textContent());

        const job = await test.step('B puts 10 on a job, and it leaves his wallet',
            async () => {
                const name = await opens(b, null);
                await prices(b, 10);
                await panel(b, 'Wallet');
                await expect(balance(b)).toHaveText((had - 10).toFixed(2), { timeout: UI });
                await expect(b.page.locator('.wallet-history li').first())
                    .toContainText('the price of render job');
                return name;
            });

        await test.step('B withdraws it before anybody takes the job, and it comes back',
            async () => {
                await opens(b, job);
                await b.page.getByRole('button', { name: 'Withdraw the price' })
                    .click({ timeout: UI });
                await panel(b, 'Wallet');
                await expect(balance(b)).toHaveText(had.toFixed(2), { timeout: UI });
                await expect(b.page.locator('.wallet-history li').first())
                    .toContainText('came back');
            });

        await test.step('B puts 10 on it again', async () => {
            await opens(b, job);
            await prices(b, 10);
        });

        const c = await open(browser, world, 'C', testInfo);
        await cIsPaid(c, job);
        await b.close();
        await c.close();
    });
