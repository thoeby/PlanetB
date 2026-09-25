// Story 42 — the `motion` and `interact` blocks (TASKS-live.md LV.3).
//
// B gives story 41's gate a second flow, built from two blocks only: On
// Trigger (a click) and Turn To (the bar up, over two seconds), the one's Fired
// wired into the other's When. Run on alpha before anybody has clicked, the
// gate stays shut. A clicks it; B runs the flow again, and A sees the bar go up.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { closeAutomate, dragIn, footOf, nodeNames, saves, selectBlock } from './automate.js';
import { GATE_AT, goesToTheLand, stands, wire, wired } from './things.js';

const LIVE = 10_000;

// The gate on Ben's field: the thing of the product Schranke in view.
async function theGate(p) {
    await expect.poll(() => p.page.evaluate(() => [...window.splatworld.preview.rows.values()]
        .find((r) => r.name === 'Schranke')?.id ?? null), { timeout: UI }).not.toBeNull();
    return p.page.evaluate(() => [...window.splatworld.preview.rows.values()]
        .find((r) => r.name === 'Schranke').id);
}

// What one tab has the bar at, as livedraw last put it.
const barAt = (p, id) => p.page.evaluate((want) =>
    window.splatworld.liveDraw.extra.get(want)?.get('bar')?.at?.pitch ?? 0, id);

async function selectsIt(b, gate) {
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    await expect.poll(() => footOf(b, gate), { timeout: UI }).not.toBeNull();
    const at = await footOf(b, gate);
    await b.page.mouse.click(at.x, at.y);
    await expect(b.page.locator('.build-flows-section')).toBeVisible({ timeout: UI });
}

const field = (b, port) => b.page.locator(`#flows li[data-port="${port}"] input`);

async function buildsTheFlow(b, gate) {
    await b.page.locator('.build-flows-acts').getByRole('button', { name: 'Add flow' }).click();
    await b.page.getByLabel('name the flow').fill('Gate opens');
    await b.page.locator('.build-flows-ask').getByRole('button', { name: 'Create' }).click();
    await expect(b.page.locator('#flows .fl-top .name')).toHaveText('Gate opens', { timeout: UI });
    // Only the two blocks: what Add flow put there is taken away.
    for (const name of ['World Clock', 'Write Port']) {
        await selectBlock(b, name);
        await b.page.keyboard.press('Delete');
    }
    await dragIn(b, 'On Trigger', 'On Trigger', [0.3, 0.4]);
    await dragIn(b, 'Turn To', 'Turn To', [0.65, 0.4]);
    expect((await nodeNames(b)).filter((n) => !['world', 'world_key'].includes(n)).sort())
        .toEqual(['On Trigger', 'Turn To']);

    await selectBlock(b, 'On Trigger');
    await b.page.locator('#flows li[data-port="Object"] select.fl-object').selectOption(gate);
    await field(b, 'Kind').fill('click');
    await field(b, 'Kind').blur();

    await selectBlock(b, 'Turn To');
    await b.page.locator('#flows li[data-port="Object"] select.fl-object').selectOption(gate);
    await b.page.locator('#flows li[data-port="Port"] select.fl-port').selectOption('pose');
    await field(b, 'Pitch').fill('80');
    await field(b, 'Pitch').blur();
    await field(b, 'Over').fill('2');
    await field(b, 'Over').blur();

    await wire(b, { node: 'On Trigger', port: 'Fired' }, { node: 'Turn To', port: 'When' });
    expect(await wired(b, { node: 'On Trigger', port: 'Fired' },
        { node: 'Turn To', port: 'When' }), 'Fired reaches When').toBe(true);
    await saves(b);
    await closeAutomate(b);
    await panel(b, 'Place');
    await expect(b.page.locator('.build-flows li[data-flow="Gate opens"]')).toBeVisible(
        { timeout: UI });
}

async function runs(b) {
    const row = b.page.locator('.build-flows li[data-flow="Gate opens"]');
    // The first time it is Run on…; once it runs there, Update on alpha.
    await row.getByRole('button', { name: /^(Run on…|Update on alpha)$/ }).click();
    const box = b.page.locator('.build-run');
    await box.getByLabel('server').selectOption({ label: 'alpha' });
    await box.getByLabel('start').selectOption({ label: 'Now, once' });
    await box.getByRole('button', { name: /^(Run|Update) on alpha$/ }).click();
    await expect(box).toBeHidden({ timeout: UI });
    await expect(row.locator('.build-run-chip')).toHaveText('● alpha', { timeout: UI });
}

const lastRun = async (world) => {
    const calls = (await world.elx.alpha.calls()).filter((c) => c.job.includes('Gate opens'));
    const at = calls.findLastIndex((c) => c.rpc === 'triggers_since');
    return calls.slice(at);
};

test('story 42 — a gate opens from a flow of On Trigger and Turn To',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        const byTheGate = await stands(b, world, here, GATE_AT.north - 0.0001, GATE_AT.east);
        const gate = await theGate(b);
        await selectsIt(b, gate);
        await test.step('1 — B builds the flow of two blocks', () => buildsTheFlow(b, gate));

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in and stands by the gate', async () => {
            await signIn(a, 'anna@visp.example', 'Anna');
            await a.page.goto(byTheGate);
            await looking(a);
            await expect.poll(() => footOf(a, gate), { timeout: UI }).not.toBeNull();
        });

        await test.step('2 — run before anybody clicked, the gate stays shut', async () => {
            await b.page.bringToFront();
            await runs(b);
            const run = await lastRun(world);
            expect(run.map((c) => c.rpc), 'asked, and wrote nothing').toEqual(['triggers_since']);
            expect(JSON.parse(run[0].said).fired).toBe(false);
            expect(await barAt(a, gate)).toBeCloseTo(0, 3);
        });

        await test.step('3 — A clicks the gate; run again, it opens for A', async () => {
            await a.page.bringToFront();
            const at = await footOf(a, gate);
            await a.page.mouse.click(at.x, at.y);
            await expect(a.page.locator('#trigger-said'))
                .toContainText('You set off Schranke (click)', { timeout: UI });
            await b.page.bringToFront();
            await runs(b);
            const run = await lastRun(world);
            expect(run.map((c) => [c.rpc, c.status])).toEqual(
                [['triggers_since', 200], ['port_write', 200]]);
            await a.page.bringToFront();
            await expect.poll(() => barAt(a, gate), { timeout: LIVE + 3000,
                message: 'A sees the bar go up' }).toBeCloseTo(80, 1);
        });
        await a.close();
        await b.close();
    });
