// Story 57 — B walks back through his strokes, and puts the ground back
// (EDT.9, PLAN-editors.md ideas 14 and 15).
//
// The strokes since the last save are listed newest first. Clicking an older
// one undoes back to it — every cell exactly as it was — and the undone ones
// stay struck through until a new stroke replaces them. Put back is a brush
// that rubs shaping out, and a button for the whole land that asks first.

import { test, expect, UI } from './players.js';
import { ben, pointOfHisLand, shapeHisLand, shot } from './editors.js';

test.setTimeout(600_000);

const grid = (b) => b.page.evaluate(() => {
    const d = window.splatworld.sculpt.shaping().grid.data;
    let h = 0;
    for (let k = 0; k < d.length; k++) h = (h * 31 + Math.round(d[k] * 1000)) | 0;
    return h;
});
const at = (b, p) => b.page.evaluate((q) => window.splatworld.sculpt.shaping().at(q.lon, q.lat), p);

async function hold(b, p, ms) {
    await b.page.mouse.move(p.x, p.y);
    await b.page.mouse.down();
    await b.page.waitForTimeout(ms);
    await b.page.mouse.up();
}

async function putBackTheLand(b, p, rows) {
    await b.page.keyboard.press('r');
    await hold(b, p, 600);
    await b.page.locator('.sc-clear').click();
    await expect(b.page.locator('.sh-confirm')).toBeVisible();
    await b.page.locator('.sc-clear-no').click();
    expect(await at(b, p)).toBeGreaterThan(0.1);
    await b.page.locator('.sc-clear').click();
    await b.page.locator('.sc-clear-yes').click();
    await expect(b.page.locator('.sc-status')).toContainText('put back');
    expect(await at(b, p)).toBe(0);
    await expect(rows.first()).toContainText('Put back the land');
}

test('story 57 — undo back to a stroke, and put the ground back',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await shapeHisLand(b);
        const p = await pointOfHisLand(b);
        const rows = b.page.locator('.sh-history .sh-stroke');

        const first = await test.step('three strokes, newest first', async () => {
            await b.page.keyboard.press('r');
            await hold(b, p, 800);
            const afterOne = await grid(b);
            await hold(b, p, 800);
            await b.page.keyboard.press('m');
            await hold(b, p, 500);
            await expect(rows).toHaveCount(3, { timeout: UI });
            await expect(rows.first()).toContainText('Smooth');
            await expect(rows.nth(2)).toContainText('Raise');
            await expect(rows.nth(2)).toContainText(/\+\d\.\d\d m/);
            // EDT.11: and the earth it moved, in the land's card.
            await expect(b.page.locator('.sh-earth')).toContainText(/m³ raised · .* m³ lowered/);
            return afterOne;
        });

        await test.step('clicking the oldest undoes back to it, exactly', async () => {
            // The strokes are a card off the toolbar, folded until asked for.
            await b.page.locator('.sh-strokes-toggle').click();
            await rows.nth(2).click();
            await expect(b.page.locator('.sc-status')).toHaveText('undone back to it');
            expect(await grid(b), 'every cell as it was after the first stroke').toBe(first);
            await expect(b.page.locator('.sh-history .sh-stroke.undone')).toHaveCount(2);
            await shot(b, testInfo, 'story-48-history');
            // Folded again: the card is over the ground he paints next.
            await b.page.locator('.sh-strokes-toggle').click();
        });

        await test.step('Ctrl-Shift-Z walks forward; a new stroke replaces the undone',
            async () => {
                await b.page.keyboard.press('Control+Shift+z');
                await expect(b.page.locator('.sh-history .sh-stroke.undone')).toHaveCount(1);
                await b.page.keyboard.press('r');
                await hold(b, p, 300);
                await expect(b.page.locator('.sh-history .sh-stroke.undone')).toHaveCount(0);
                await expect(rows).toHaveCount(3);
            });

        await test.step('the Put back brush rubs shaping out', async () => {
            const was = await at(b, p);
            expect(was).toBeGreaterThan(0.2);
            await b.page.keyboard.press('x');
            await expect(b.page.locator('.sc-opt-name')).toHaveText('Put back');
            await b.page.locator('.sc-strength').fill('10');
            await b.page.locator('.sc-strength').dispatchEvent('change');
            await hold(b, p, 1500);
            expect(Math.abs(await at(b, p))).toBeLessThan(0.05);
        });

        await test.step('Put back the land asks first, then puts all of it back',
            () => putBackTheLand(b, p, rows));
        await b.close();
    });
