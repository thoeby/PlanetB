// Story 46 — B's brush (EDT.7, PLAN-editors.md ideas 9, 10 and 13).
//
// The brush is on the ground before he presses. Strength is metres a second:
// holding still keeps raising, and longer is higher. Shift lowers. The
// falloff has four curves drawn in the box, the brush can be square, and in
// the last metres inside his boundary it fades and says so.

import { test, expect, UI } from './players.js';
import { ben, edgeOfHisLand, heightUnder, pointOfHisLand, shapeHisLand, shot }
    from './editors.js';
import { differs } from './pixels.js';

test.setTimeout(600_000);

async function hold(b, at, ms, { shift = false } = {}) {
    await b.page.mouse.move(at.x, at.y);
    if (shift) await b.page.keyboard.down('Shift');
    await b.page.mouse.down();
    await b.page.waitForTimeout(ms);
    await b.page.mouse.up();
    if (shift) await b.page.keyboard.up('Shift');
}

async function brushAtRest(b, at) {
    const clip = { x: at.x - 60, y: at.y - 60, width: 120, height: 120 };
    await b.page.mouse.move(at.x + 400, at.y - 250);
    await b.page.waitForTimeout(400);
    const without = await b.page.screenshot({ clip });
    await b.page.mouse.move(at.x, at.y, { steps: 3 });
    await b.page.waitForTimeout(400);
    const withIt = await b.page.screenshot({ clip });
    expect(differs(without, withIt), 'the ring is drawn where the pointer rests')
        .toBeGreaterThan(0.002);
}

test('story 46 — metres a second, a curve, a square, and a soft edge',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await shapeHisLand(b);
        const at = await pointOfHisLand(b);

        await test.step('the brush is on the ground before any press', () => brushAtRest(b, at));

        await test.step('a press moves the clay at once, and holding keeps raising', async () => {
            const was = await heightUnder(b, at);
            await b.page.mouse.move(at.x, at.y);
            await b.page.mouse.down();
            const pressed = await heightUnder(b, at);
            expect(pressed.clay, 'the clay moved with the press').toBeGreaterThan(was.clay);
            await b.page.waitForTimeout(400);
            await b.page.mouse.up();
            const short = (await heightUnder(b, at)).grid - was.grid;
            await hold(b, at, 2000);
            const long = (await heightUnder(b, at)).grid - was.grid - short;
            expect(long, 'held five times as long, it went higher').toBeGreaterThan(short * 1.5);
            await expect(b.page.locator('.sc-said')).toContainText('2 strokes unsaved');
        });

        await test.step('Shift lowers', async () => {
            const was = (await heightUnder(b, at)).grid;
            await hold(b, at, 1200, { shift: true });
            expect((await heightUnder(b, at)).grid).toBeLessThan(was);
        });

        await test.step('the curve and the shape are in the box', async () => {
            const path = b.page.locator('.sc-curve path');
            const smooth = await path.getAttribute('d');
            await b.page.locator('.sc-curves button[data-curve="sharp"]').click();
            await expect(b.page.locator('.sc-curves button[data-curve="sharp"]'))
                .toHaveAttribute('aria-pressed', 'true');
            expect(await path.getAttribute('d')).not.toBe(smooth);
            await b.page.locator('.sc-shapes button[data-shape="square"]').click();
            expect(await b.page.evaluate(() => window.splatworld.sculpt.state.shape))
                .toBe('square');
            await b.page.locator('.sc-strength').fill('2');
            await b.page.locator('.sc-strength').dispatchEvent('change');
            await expect(b.page.locator('.sc-brush-says')).toContainText('2 m/s');
            await shot(b, testInfo, 'story-46-brush');
        });

        await test.step('by his boundary the brush fades, and says so', async () => {
            // Close enough that a metre is some pixels.
            let edge = await edgeOfHisLand(b);
            await b.page.mouse.move(edge.x, edge.y);
            for (let n = 0; n < 8; n++) await b.page.mouse.wheel(0, -300);
            edge = await edgeOfHisLand(b);
            await b.page.mouse.move(edge.x, edge.y, { steps: 3 });
            await expect(b.page.locator('.bp-tag')).toHaveText('edge blend', { timeout: UI });
        });
        await b.close();
    });
