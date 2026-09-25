// Story 44 — B drags a section across his field (EDT.5, PLAN-editors.md
// idea 6).
//
// With the section tool in hand a drag on the ground is a line, and letting
// go opens a strip along the bottom: the ground's height along it and its
// steepest slope. Hovering the strip marks the point on the ground; hovering
// the ground near the line marks the strip.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand, drag, shot } from './editors.js';

test.setTimeout(600_000);

test('story 44 — a section across the field, and the strip follows the pointer',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await blueprintOverHisLand(b, 'section');
        const strip = b.page.locator('#profile-strip');

        await test.step('a drag draws the line, letting go opens the strip', async () => {
            await drag(b, [{ x: 600, y: 480 }, { x: 700, y: 450 }, { x: 860, y: 420 }]);
            await expect(strip).toBeVisible({ timeout: UI });
            await expect(strip.locator('.ps-title')).toHaveText(/Section · \d+ m/);
            await expect(strip.locator('.ps-says')).toContainText('steepest');
            const n = await b.page.evaluate(() => window.splatworld.bpmode.strip.samples.length);
            expect(n, 'sampled every metre').toBeGreaterThan(10);
            await shot(b, testInfo, 'story-44-section');
        });

        await test.step('hovering the strip marks the ground', async () => {
            const c = await strip.locator('canvas').boundingBox();
            await b.page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.5, { steps: 3 });
            await expect.poll(() => b.page.evaluate(() =>
                window.splatworld.bpmode.state.marked?.at ?? null), { timeout: UI })
                .toBeGreaterThan(0);
        });

        await test.step('hovering the ground by the line marks the strip', async () => {
            // The middle of the line he dragged.
            await b.page.mouse.move(730, 450, { steps: 3 });
            await b.page.mouse.move(731, 450, { steps: 2 });
            await expect.poll(() => b.page.evaluate(() =>
                window.splatworld.bpmode.strip.marked?.at ?? null)).not.toBeNull();
        });

        await test.step('the strip closes', async () => {
            await strip.locator('.ps-close').click();
            await expect(strip).toBeHidden();
        });
        await b.close();
    });
