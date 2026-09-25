// Story 43 — the ground says what it is, at the pointer (EDT.4,
// PLAN-editors.md idea 4, idea 5 and §3 rule 3).
//
// A small box follows the pointer with the ground's height, how far it is off
// the elevation and its slope; a two-word tag says what state the pointer is
// in — "not your land" past his boundary, "no ground" over the sky. Holding
// Tab brings the splats back over the clay for as long as it is held, and
// does not open the apps drawer while it does.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand, screenAt } from './editors.js';

test.setTimeout(600_000);

test('story 43 — numbers and words at the pointer, and a peek under the clay',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await blueprintOverHisLand(b);
        const tag = b.page.locator('.bp-tag');
        const box = b.page.locator('.bp-nums');

        await test.step('over his land: the numbers, and no tag', async () => {
            const at = await screenAt(b, 'inside');
            await b.page.mouse.move(at.x, at.y, { steps: 4 });
            await expect(box).toBeVisible({ timeout: UI });
            await expect(box).toContainText('ground');
            await expect(box).toContainText('off the elevation');
            await expect(box).toContainText('slope');
            await expect(tag).toBeHidden();
        });

        await test.step('past his boundary: "not your land"', async () => {
            const at = await screenAt(b, 'outside');
            expect(at, 'some ground off his land is in view').not.toBeNull();
            await b.page.mouse.move(at.x, at.y, { steps: 4 });
            await expect(tag).toHaveText('not your land', { timeout: UI });
            await expect(tag).toHaveAttribute('data-tone', 'bad');
        });

        await test.step('over the sky: "no ground"', async () => {
            // Looking out across the valley at the flattest the camera goes,
            // the top of the view is past any ground there is.
            await b.page.evaluate(() => {
                const cam = window.splatworld.bpmode.cam;
                cam.state.pitch = 30;
                cam.state.distance = 6000;
                cam.update();
            });
            await b.page.mouse.move(1000, 52, { steps: 4 });
            await expect(tag).toHaveText('no ground', { timeout: UI });
        });

        await test.step('Tab held peeks at the splats, and the drawer stays shut', async () => {
            await b.page.mouse.move(640, 420);
            await b.page.keyboard.down('Tab');
            await expect.poll(() => b.page.evaluate(() =>
                window.splatworld.streamer.hidden.size)).toBe(0);
            await expect(b.page.locator('#apps')).toBeHidden();
            await b.page.keyboard.up('Tab');
            await expect.poll(() => b.page.evaluate(() =>
                window.splatworld.streamer.hidden.size)).toBeGreaterThan(0);
            expect(await b.page.evaluate(() => window.splatworld.blueprint.material().opacity))
                .toBe(1);
        });
        await b.close();
    });
