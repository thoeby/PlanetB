// Story 38 — a thing's flow runs on a process server (TASKS-flows.md FL.7).
//
// B switches the lamp off by hand, then runs its flow "Lamp at dusk" (story 37)
// on alpha from the lamp's panel. The page sends the flow, makes the job and
// the world issues it a key; alpha runs it, and its Write Port switches the
// lamp on with that key. A, standing by the lamp, sees it go on. B stops it:
// the key is withdrawn, and when alpha runs the job once more anyway, the world
// refuses it and the lamp stays as B left it.

import { test, expect, open, looking, signIn, UI } from './players.js';
import { byTheLamp, selectsTheLamp, whereTheLampIs } from './automate.js';

const LIVE = 10_000;
const row = (p) => p.page.locator('.build-flows li[data-flow="Lamp at dusk"]');
const isOn = (p, lamp) => p.page.evaluate((id) => window.splatworld.live.at(id, 'on'), lamp);

async function switchesItOff(b) {
    const on = b.page.locator('.build-ports li[data-port="on"] input');
    await expect(on).toBeVisible({ timeout: UI });
    if (await on.isChecked()) {
        await on.uncheck();
        await expect(b.page.locator('.build-ports-said')).toContainText('on set', { timeout: UI });
    }
}

// After the flow has run, B's own switch still shows what B last set (the
// panel reads a thing's ports when it is selected), so B flicks it on and off.
async function flicksItOff(b, lamp) {
    const on = b.page.locator('.build-ports li[data-port="on"] input');
    if (!(await on.isChecked())) {
        await on.check();
        await expect.poll(() => isOn(b, lamp), { timeout: LIVE }).toBe(true);
    }
    await on.uncheck();
    await expect.poll(() => isOn(b, lamp), { timeout: LIVE }).toBe(false);
}

async function runsIt(b) {
    await row(b).getByRole('button', { name: 'Run on…' }).click();
    const box = b.page.locator('.build-run');
    await box.getByLabel('server').selectOption({ label: 'alpha' });
    await box.getByLabel('start').selectOption({ label: 'Now, once' });
    await expect(box).toContainText('gives it a key that can change things on Ben’s field only');
    await box.getByRole('button', { name: 'Run' }).click();
    await expect(box).toBeHidden({ timeout: UI });
    await expect(row(b).locator('.build-run-chip')).toHaveText('● alpha', { timeout: UI });
}

test('story 38 — a thing’s flow runs on a process server', async ({ browser, world },
    testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
    const url = await test.step('and goes to the lamp', () => whereTheLampIs(b, world));
    const lamp = await test.step('and selects it', async () => {
        const id = await byTheLamp(b, url);
        await selectsTheLamp(b, id);
        return id;
    });
    await test.step('B switches it off by hand', () => switchesItOff(b));

    const a = await open(browser, world, 'A', testInfo);
    await test.step('A stands by the lamp and sees it off', async () => {
        await signIn(a, 'anna@visp.example', 'Anna');
        await a.page.goto(url);
        await looking(a);
        await expect.poll(() => isOn(a, lamp), { timeout: UI }).toBe(false);
    });

    await test.step('1 — B runs Lamp at dusk on alpha, and A sees the lamp go on', async () => {
        await b.page.bringToFront();
        await runsIt(b);
        const calls = await world.elx.alpha.calls();
        expect(calls.at(-1)?.status, 'alpha wrote with the key it was given').toBe(200);
        await a.page.bringToFront();
        await expect.poll(() => isOn(a, lamp), { timeout: LIVE }).toBe(true);
    });

    await test.step('2 — B stops it; a run that comes anyway is refused', async () => {
        await b.page.bringToFront();
        await row(b).getByRole('button', { name: 'Stop' }).click();
        const ask = b.page.locator('.build-confirm');
        await expect(ask).toContainText(
            'Stop Lamp at dusk on alpha? The process stays there; its key is withdrawn.');
        await ask.getByRole('button', { name: 'Stop' }).click();
        await expect(b.page.locator('.build-flows-said'))
            .toHaveText('Lamp at dusk stopped on alpha; its key is withdrawn.', { timeout: UI });
        await flicksItOff(b, lamp);
        const again = await world.elx.alpha.replay('Lamp at dusk');
        expect(again.code, 'the world refuses a withdrawn key').toBe(1);
        expect(again.lines.join(' ')).toContain('not your land');
        await a.page.bringToFront();
        await expect.poll(() => isOn(a, lamp), { timeout: LIVE }).toBe(false);
    });
    // Every window is a 3D view competing for one machine (story 30).
    await a.close();
    await b.close();
});
