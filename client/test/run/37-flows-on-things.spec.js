// Story 37 — a flow belongs to a thing (TASKS-flows.md FL.6).
//
// B selects the lamp story 30 put on Ben's field and adds a flow to it from
// the lamp's own panel: Automate opens on a flow that already has World Clock,
// and Write Port pointed at the lamp and at its switch. Back in the world the
// lamp lists it. C, who builds there by grant, opens it from the lamp; D, who
// does not, is told why there is nothing to press. B detaches it and it is a
// flow of the land's again, under "Flows without a thing".

import { test, expect, open, panel, signIn, UI } from './players.js';
import { byTheLamp, closeAutomate, nodeNames, saves, selectBlock, selectsTheLamp,
    whereTheLampIs } from './automate.js';

const flowRow = (p, name) => p.page.locator(`.build-flows li[data-flow="${name}"]`);

// What the block has been told, read off the graph the way the save reads it
// (story 29).
const constants = (p, name) => p.page.evaluate((want) => {
    const node = (window.splatworld.flows.canvas().graph._nodes ?? [])
        .find((n) => n._irName === want);
    return Object.fromEntries((node?._irConstants ?? [])
        .map((c) => [c.port, c.value?.value?.data ?? '']));
}, name);

async function addsTheFlow(b, lamp) {
    await expect(b.page.locator('.build-flows')).toContainText(
        'No flows on this Strassenlampe yet.', { timeout: UI });
    await b.page.locator('.build-flows-acts').getByRole('button', { name: 'Add flow' }).click();
    await b.page.getByLabel('name the flow').fill('Lamp at dusk');
    await b.page.locator('.build-flows-ask').getByRole('button', { name: 'Create' }).click();
    await expect(b.page.locator('#flows .fl-top .name')).toHaveText('Lamp at dusk',
        { timeout: UI });
    await expect.poll(() => nodeNames(b), { timeout: UI })
        .toEqual(expect.arrayContaining(['world', 'world_key', 'World Clock', 'Write Port']));
    const told = await constants(b, 'Write Port');
    expect(told.Object, 'Write Port is pointed at the lamp').toBe(lamp);
    expect(told.Port, 'and at its switch').toBe('on');
    // The lamp goes on at dusk: B ticks the value, and saves.
    await selectBlock(b, 'Write Port');
    await b.page.locator('#flows li[data-port="Value"] input').check();
    await saves(b);
    await closeAutomate(b);
    // Back in the world, the lamp's panel lists it.
    await panel(b, 'Place');
    await expect(flowRow(b, 'Lamp at dusk')).toBeVisible({ timeout: UI });
}

test('story 37 — a flow belongs to a thing', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
    const url = await test.step('and goes to where the lamp is', () => whereTheLampIs(b, world));
    const lamp = await test.step('and selects the lamp', async () => {
        const id = await byTheLamp(b, url);
        await selectsTheLamp(b, id);
        return id;
    });
    await test.step('1 — B adds a flow to the lamp', () => addsTheFlow(b, lamp));

    await test.step('2 — C, who builds here, opens it from the lamp', async () => {
        const c = await open(browser, world, 'C', testInfo);
        await signIn(c, 'cara@visp.example', 'Cara');
        await selectsTheLamp(c, await byTheLamp(c, url));
        await flowRow(c, 'Lamp at dusk').getByRole('button', { name: 'Open' }).click();
        await expect(c.page.locator('#flows .fl-top .name')).toHaveText('Lamp at dusk',
            { timeout: UI });
        await c.close();
    });

    await test.step('3 — D, who does not, is told why there is nothing to press', async () => {
        const d = await open(browser, world, 'D', testInfo);
        await signIn(d, 'dora@visp.example', 'Dora');
        await selectsTheLamp(d, await byTheLamp(d, url));
        await expect(d.page.locator('.build-flows-said'))
            .toHaveText('Only people who build on Ben’s field change its flows.', { timeout: UI });
        await expect(d.page.locator('.build-flows-acts button')).toHaveCount(0);
        await d.close();
    });

    await test.step('4 — B detaches it, and it is the land’s again', async () => {
        await b.page.bringToFront();
        await flowRow(b, 'Lamp at dusk').getByRole('button', { name: 'Detach' }).click();
        await expect(b.page.locator('.build-flows')).toContainText(
            'No flows on this Strassenlampe yet.', { timeout: UI });
        await b.page.locator('.build-flows-acts')
            .getByRole('button', { name: 'Attach existing…' }).click();
        await b.page.getByLabel('which flow').selectOption({ label: 'Lamp at dusk' });
        await b.page.locator('.build-flows-ask').getByRole('button', { name: 'Attach' }).click();
        await expect(flowRow(b, 'Lamp at dusk')).toBeVisible({ timeout: UI });
        await b.close();
    });
});
