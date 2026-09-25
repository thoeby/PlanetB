// Story 41 — products declare triggers (TASKS-live.md LV.2).
//
// C registers a gate that is set off by somebody coming within five metres,
// or by a click.
// B puts one on his field and gives it a flow that reads what happened, with
// Events Since. B walks up to the gate: the page says he set it off, once, and
// the world has one event. B runs the flow on alpha; alpha asks the world with
// the flow's key and is told about B walking up.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { closeAutomate, dragIn, nodeNames, saves } from './automate.js';
import { GATE_AT, goesToTheLand, plants, registers, sees, stands } from './things.js';

// B starts walking twenty metres south of the gate, facing north.
const START = { north: GATE_AT.north - 0.00018, east: GATE_AT.east };

async function registersTheGate(c) {
    await registers(c, 'gate.glb', 'Schranke', [{ node: 'bar', role: 'joint', ports: ['pose'] }],
        async () => {
            await c.page.locator('#form-parts .mk-trigger-kind').selectOption('near');
            await c.page.locator('#form-parts .mk-trigger-m').fill('5');
            await c.page.locator('#form-parts .mk-trigger-add').click();
            await expect(c.page.locator('#form-parts .mk-said'))
                .toContainText('near 5 m', { timeout: UI });
            // And a click, which story 42's flow listens for.
            await c.page.locator('#form-parts .mk-trigger-kind').selectOption('click');
            await c.page.locator('#form-parts .mk-trigger-add').click();
            await expect(c.page.locator('#form-parts .mk-said'))
                .toContainText('set off by: click, near 5 m', { timeout: UI });
        });
}

// The gate's own flow, from its panel, with Events Since put in beside what
// Add flow already put there.
async function givesItAFlow(b) {
    await b.page.locator('.build-flows-acts').getByRole('button', { name: 'Add flow' }).click();
    await b.page.getByLabel('name the flow').fill('Who came by');
    await b.page.locator('.build-flows-ask').getByRole('button', { name: 'Create' }).click();
    await expect(b.page.locator('#flows .fl-top .name')).toHaveText('Who came by',
        { timeout: UI });
    await dragIn(b, 'Events Since', 'Events Since', [0.5, 0.7]);
    await expect.poll(() => nodeNames(b), { timeout: UI })
        .toEqual(expect.arrayContaining(['Events Since']));
    await saves(b);
    await closeAutomate(b);
}

const fired = (p) => p.page.evaluate(() => window.splatworld.triggers.triggers.fired
    .map((f) => ({ instance: f.instance, kind: f.kind })));

// B walks north until the page says the gate noticed him.
async function walksUp(b, gate) {
    // Out of build mode, where the keys walk (a hash that moves you does not
    // reload the page, so the Place panel is as B left it).
    await panel(b, 'Place');
    const building = b.page.locator('.build-toggle');
    if (await building.isChecked()) await building.uncheck();
    // The switch keeps the keys (a field is not walked in, client/js/player.js).
    await b.page.evaluate(() => document.activeElement?.blur());
    await b.page.keyboard.down('w');
    try {
        await expect(b.page.locator('#trigger-said'))
            .toContainText('You set off Schranke (near)', { timeout: UI });
    } finally {
        await b.page.keyboard.up('w');
    }
    // Standing there a moment longer is still one arrival.
    await b.page.waitForTimeout(2000);
    expect(await fired(b), 'one firing, of the gate, for coming near')
        .toEqual([{ instance: gate, kind: 'near' }]);
}

async function runsItOnAlpha(b, world) {
    const row = b.page.locator('.build-flows li[data-flow="Who came by"]');
    await row.getByRole('button', { name: 'Run on…' }).click();
    const box = b.page.locator('.build-run');
    await box.getByLabel('server').selectOption({ label: 'alpha' });
    await box.getByLabel('start').selectOption({ label: 'Now, once' });
    await box.getByRole('button', { name: 'Run' }).click();
    await expect(box).toBeHidden({ timeout: UI });
    await expect(row.locator('.build-run-chip')).toHaveText('● alpha', { timeout: UI });
    const calls = (await world.elx.alpha.calls()).filter((c) => c.job.includes('Who came by')
        || c.rpc === 'world_events');
    const read = calls.findLast((c) => c.rpc === 'world_events');
    expect(read?.status, 'alpha asked the world what happened, with the flow\'s key')
        .toBe(200);
    return JSON.parse(read.said);
}

test('story 41 — a gate is set off by walking up to it, and a flow hears it',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C registers a gate that opens for whoever comes near',
            () => registersTheGate(c));
        await c.close();

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        await stands(b, world, here, GATE_AT.north, GATE_AT.east);
        const gate = await test.step('B puts the gate down', () => plants(b, 'Schranke'));
        await test.step('and gives it a flow that reads what happened', () => givesItAFlow(b));

        await test.step('1 — B walks up to the gate, and it notices him once', async () => {
            await stands(b, world, here, START.north, START.east);
            await looking(b);
            // He looks up the road first: the gate is there, some way ahead.
            await sees(b, gate).toBe(true);
            await walksUp(b, gate);
        });

        await test.step('2 — the flow, run on alpha, reads it with Events Since', async () => {
            await stands(b, world, here, GATE_AT.north, GATE_AT.east);
            await panel(b, 'Place');
            await b.page.locator('.build-toggle').check();
            await b.page.mouse.click(640, 520);
            await expect(b.page.locator('.build-flows-section')).toBeVisible({ timeout: UI });
            const said = await runsItOnAlpha(b, world);
            const mine = said.events.filter((e) => e.instance === gate && e.kind === 'trigger');
            expect(mine.map((e) => e.data.trigger), 'the one arrival, and nothing else')
                .toEqual(['near']);
            expect(mine[0].player).toBe('Ben');
            expect(said.last_id).toBeGreaterThanOrEqual(mine[0].id);
        });
        await b.close();
    });
