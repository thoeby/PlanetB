// Story 46 — a flow is run on somebody else's server (TASKS-live.md LV.10).
//
// B has no wish to keep a machine running for his gate: he offers its flow
// "Gate opens" (story 42) to the pool for a minute. C, who keeps a process
// server of her own, takes it in Work › Flows and runs it on beta. Beta writes
// to the world with the key the world issued for that land and that minute.
// When the minute is over the flow is gone from beta, the key refuses, and C
// settles it.

import { test, expect, open, panel, panelApp, signIn, UI } from './players.js';
import { footOf, serverSelect } from './automate.js';
import { GATE_AT, goesToTheLand, stands } from './things.js';

const flowRow = (p) => p.page.locator('.build-flows li[data-flow="Gate opens"]');

async function offers(b, world) {
    const here = await goesToTheLand(b);
    await stands(b, world, here, GATE_AT.north - 0.0001, GATE_AT.east);
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const gate = await b.page.evaluate(() => [...window.splatworld.preview.rows.values()]
        .find((r) => r.name === 'Schranke')?.id ?? null);
    await expect.poll(() => footOf(b, gate), { timeout: UI }).not.toBeNull();
    const at = await footOf(b, gate);
    await b.page.mouse.click(at.x, at.y);
    await expect(flowRow(b)).toBeVisible({ timeout: UI });
    await flowRow(b).getByRole('button', { name: 'Delegate…' }).click();
    await b.page.getByLabel('for how many minutes').fill('1');
    await b.page.locator('.build-flows-ask').getByRole('button', { name: 'Offer' }).click();
    await expect(b.page.locator('.build-flows-said'))
        .toHaveText('Gate opens is offered to run for 1 min.', { timeout: UI });
}

// C keeps a server of her own: the same beta, added as hers.
async function keepsAServer(c, world) {
    await panelApp(c, 'Automate');
    await serverSelect(c).selectOption({ label: 'Add a server…' });
    const dialog = c.page.locator('#flows .fl-srv-dialog');
    await dialog.getByLabel('Server name').fill('beta');
    await dialog.getByLabel('Server address').fill(world.elx.beta.url);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden({ timeout: UI });
    // Nothing was drawn; whatever the empty canvas thinks it holds is not kept.
    await c.page.locator('#flows .fl-close').click();
    const box = c.page.locator('#flows .fl-ask');
    if (await box.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
        await box.getByRole('button', { name: 'Discard' }).click();
    }
    await expect(c.page.locator('#flows')).toBeHidden({ timeout: UI });
}

const offer = (c) => c.page.locator('.duties li.duty', { hasText: 'Gate opens' }).first();

async function takesIt(c) {
    await panel(c, 'Flows to run');
    await expect(offer(c)).toContainText('Gate opens on Ben’s field · offered by Ben',
        { timeout: UI });
    await offer(c).getByLabel('run on').selectOption({ label: 'beta' });
    await offer(c).getByRole('button', { name: 'Run' }).click();
    await expect(c.page.locator('.duties-said')).toContainText('running on beta until',
        { timeout: UI });
}

test('story 46 — a gate’s flow is delegated, run for its term, and gone',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('1 — B offers the gate’s flow to the pool for a minute',
            () => offers(b, world));
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('and keeps a server of her own', () => keepsAServer(c, world));
        await test.step('2 — C runs it on beta, and beta writes with the job’s key', async () => {
            await takesIt(c);
            const calls = (await world.elx.beta.calls()).filter((x) => x.job.startsWith('duty-'));
            expect(calls.map((x) => [x.rpc, x.status]).slice(0, 1),
                'beta asked the world, with the key it was given')
                .toEqual([['triggers_since', 200]]);
        });
        const job = (await world.elx.beta.calls()).find((x) => x.job.startsWith('duty-')).job;

        await test.step('3 — after the term the flow is gone from beta, and the key refuses',
            async () => {
                await expect.poll(async () => {
                    const res = await fetch(`${world.elx.beta.url}/api/v1/process`);
                    return (await res.text()).includes(job);
                }, { timeout: 120_000, intervals: [5000], message: 'beta forgets the flow' })
                    .toBe(false);
                const again = await world.elx.beta.replay(job);
                expect(again.code, 'the world refuses the key once its term is over').toBe(1);
                expect(again.lines.join(' ')).toMatch(/401|JWT expired|not yours/);
            });

        await test.step('4 — C settles it', async () => {
            await panel(c, 'Flows to run');
            await offer(c).getByRole('button', { name: 'Settle' }).click();
            await expect(c.page.locator('.duties-said')).toHaveText('settled: 1 run(s)',
                { timeout: UI });
        });
        await c.close();
    });
