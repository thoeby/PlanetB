// Story 49 — the operator's limit, a save that does not go through, and
// leaving with strokes unsaved (EDT.10, PLAN-editors.md idea 16, §2.2).
//
// Anna sets how far a land's ground may move. Ben's brush stops at it and the
// pointer says "over limit". His save meets a PostgREST that is not answering:
// the strokes are kept on his machine, Retry is offered, and a reload puts
// them back. Leaving Shape with strokes unsaved asks Save / Discard / Stay.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { ben, heightUnder, pointOfHisLand, shapeHisLand } from './editors.js';

test.setTimeout(600_000);

async function limit(browser, world, testInfo, metres) {
    const a = await open(browser, world, 'A', testInfo);
    await signIn(a, 'anna@visp.example', 'Anna');
    await panel(a, 'Setup');
    const box = a.page.locator('.ss-shaping');
    await expect(box).toBeVisible({ timeout: UI });
    await box.locator('.ss-up').fill(String(metres));
    await box.locator('.ss-save').click();
    await expect(box.locator('.ss-said')).toContainText('saved', { timeout: UI });
    await a.close();
}

async function hold(b, p, ms) {
    await b.page.mouse.move(p.x, p.y);
    await b.page.mouse.down();
    await b.page.waitForTimeout(ms);
    await b.page.mouse.up();
}

async function stopsAtTheLimit(b, p) {
    await b.page.locator('.sc-strength').fill('4');
    await b.page.locator('.sc-strength').dispatchEvent('change');
    await b.page.mouse.move(p.x, p.y);
    await b.page.mouse.down();
    await b.page.waitForTimeout(1500);
    await expect(b.page.locator('.bp-tag')).toHaveText('over limit', { timeout: UI });
    await expect(b.page.locator('.bp-nums')).toContainText('limit');
    await b.page.mouse.up();
    const got = await heightUnder(b, p);
    expect(got.grid, 'no cell past the operator’s metre').toBeLessThanOrEqual(1.0001);
    expect(got.grid).toBeGreaterThan(0.9);
}

async function saveFailsAndIsKept(b) {
    await b.page.route('**/rpc/save_height_edit', (r) => r.abort());
    await b.page.locator('.sc-save').click();
    await expect(b.page.locator('.sc-status')).toContainText('kept on this machine',
        { timeout: UI });
    await expect(b.page.locator('.sc-retry')).toBeVisible();
    await b.page.unroute('**/rpc/save_height_edit');
}

async function reloadAndRetry(b, p) {
    await b.page.reload();
    await b.page.waitForFunction(() => Boolean(window.splatworld?.sculpt), null,
        { timeout: 120000 });
    await shapeHisLand(b);
    await expect(b.page.locator('.sc-status')).toContainText('kept on this machine',
        { timeout: UI });
    expect((await heightUnder(b, p)).grid, 'the kept ground is back').toBeGreaterThan(0.9);
    await b.page.locator('.sc-retry').click();
    await expect(b.page.locator('.sc-status')).toContainText(/ground saved · \d+ tiles? changed/,
        { timeout: UI });
    await expect(b.page.locator('.sc-retry')).toBeHidden();
}

async function leavingAsks(b, p) {
    await hold(b, p, 300);
    await b.page.keyboard.press('3');
    const ask = b.page.locator('#sh-leave');
    await expect(ask).toBeVisible({ timeout: UI });
    await expect(ask).toContainText('1 stroke on Ben’s field not saved');
    await ask.locator('.sh-leave-stay').click();
    await expect(b.page.locator('#panel header .title')).toHaveText('Shape', { timeout: UI });
    expect(await b.page.evaluate(() => window.splatworld.blueprint.active)).toBe(true);
    await b.page.keyboard.press('Escape');
    await expect(ask).toBeVisible({ timeout: UI });
    await ask.locator('.sh-leave-discard').click();
    await b.page.waitForFunction(() => !window.splatworld.blueprint.active, null,
        { timeout: UI });
    expect(await b.page.evaluate(() => window.splatworld.sculpt.shaping().strokes.length))
        .toBe(0);
}

test('story 49 — a limit that holds, a save that is kept, and a question on leaving',
    async ({ browser, world }, testInfo) => {
        await test.step('Anna allows a metre up', () => limit(browser, world, testInfo, 1));
        const b = await ben(browser, world, testInfo);
        await shapeHisLand(b);
        const p = await pointOfHisLand(b);
        await test.step('the brush stops at the limit and says so', () => stopsAtTheLimit(b, p));
        await test.step('the save fails, and the strokes are kept', () => saveFailsAndIsKept(b));
        await test.step('a reload puts them back, and Retry sends them',
            () => reloadAndRetry(b, p));
        await test.step('leaving with a stroke unsaved asks first', () => leavingAsks(b, p));
        await b.close();
        await test.step('Anna puts the limit back', () => limit(browser, world, testInfo, 8));
    });
