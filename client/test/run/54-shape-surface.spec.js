// Story 54 — Shape is a surface of Build's own (EDT.6, PLAN-editors.md D1).
//
// The plinth is Place · Catalog · Land · Shape · Lines · Publish on 1 to 6.
// Pressing 4 opens Shape, and opening Shape is shaping: his field turns to
// clay under the camera, the rail heads the panel. Closing it hands the
// camera back to him where he stood.

import { test, expect, open, signUp, UI } from './players.js';
import { ben, cameraOf, shot } from './editors.js';
import { meanColour } from './pixels.js';

test.setTimeout(600_000);

// Every word the loading screen says while it is up.
const watchLoading = (page) => page.evaluate(() => {
    const seen = [];
    window.loadingSaid = seen;
    const node = document.getElementById('bp-loading');
    new window.MutationObserver(() => {
        if (!node.hidden) seen.push(node.textContent);
    }).observe(node, { attributes: true, childList: true, subtree: true, characterData: true });
});

// A loading screen while the land, its elevation and the clay come, and gone
// once they have (the operator's note).
async function loadingWasShown(page) {
    await expect(page.locator('#bp-loading')).toBeHidden({ timeout: UI });
    const said = await page.evaluate(() => window.loadingSaid.join(' | '));
    expect(said).toContain('Opening your land as clay');
    expect(said).toContain('Building the clay');
}

test('story 54 — open Shape, see white land, get his eyes back on close',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        const page = b.page;

        await test.step('the plinth is six surfaces, Shape on 4 and Lines on 5', async () => {
            await expect(page.locator('#tabs .tab .label'))
                .toHaveText(['Place', 'Catalog', 'Land', 'Shape', 'Lines', 'Publish']);
            await expect(page.locator('#tabs .tab .key'))
                .toHaveText(['1', '2', '3', '4', '5', '6']);
        });

        const eyes = await page.evaluate(() => ({ ...window.splatworld.player.position }));
        await test.step('4 opens Shape onto his field as clay', async () => {
            await page.mouse.move(900, 400);
            await watchLoading(page);
            await page.keyboard.press('4');
            await expect(page.locator('#panel header .title')).toHaveText('Shape');
            await expect(page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
            await page.waitForFunction(() => window.splatworld.blueprint.active, null,
                { timeout: UI });
            await loadingWasShown(page);
            await expect(page.locator('#sculpt-tools .sc-rail')).toBeVisible();
            await expect(page.locator('.sc-status')).toContainText('drag on the ground');
            await expect(page.locator('#bp-side .bp-land')).toHaveText('Ben’s field');
            expect((await cameraOf(b)).on, 'the clay has the camera').toBe(true);
            await page.waitForTimeout(1000);
            const whole = await shot(b, testInfo, 'story-45-shape');
            expect(whole.length).toBeGreaterThan(0);
            const middle = meanColour(await page.screenshot(
                { clip: { x: 700, y: 300, width: 300, height: 200 } }));
            expect((middle[0] + middle[1] + middle[2]) / 3, 'white clay').toBeGreaterThan(100);
        });

        await test.step('closing Shape hands the camera back where he stood', async () => {
            await page.keyboard.press('Escape');
            await expect(page.locator('#panel')).toBeHidden();
            await page.waitForFunction(() => !window.splatworld.blueprint.active, null,
                { timeout: UI });
            await expect(page.locator('#bp-side')).toBeHidden();
            const player = await page.evaluate(() => ({ ...window.splatworld.player.position }));
            expect(Math.hypot(player.x - eyes.x, player.z - eyes.z)).toBeLessThan(0.5);
            await expect.poll(async () => {
                const c = await cameraOf(b);
                return Math.hypot(c.x - player.x, c.z - player.z);
            }, { timeout: UI }).toBeLessThan(0.5);
        });

        await test.step('and opening any other surface closes the clay too', async () => {
            await page.keyboard.press('4');
            await page.waitForFunction(() => window.splatworld.blueprint.active, null,
                { timeout: UI });
            await page.keyboard.press('3');
            await page.waitForFunction(() => !window.splatworld.blueprint.active, null,
                { timeout: UI });
        });
        await b.close();
    });

// The operator's note: a click on the ground in Shape locked the pointer and
// looked around. Nobody with land could make it happen here; somebody with
// none could — the clay never opened, so the walk camera kept the mouse.
test('story 54b — no land: Shape and Lines say so, and a click locks nothing',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await signUp(c, `noland${Date.now()}@visp.example`, 'Cleo');
        const locked = () => c.page.evaluate(() => document.pointerLockElement?.id ?? null);
        for (const [key, words, status] of [['4', 'No land of yours to shape', '.sc-status'],
            ['5', 'No land of yours to draw on', '.ln-status']]) {
            await c.page.mouse.move(640, 420);
            await c.page.keyboard.press(key);
            await expect(c.page.locator(status)).toContainText(words, { timeout: UI });
            await c.page.mouse.click(640, 420);
            await c.page.waitForTimeout(300);
            expect(await locked(), `no pointer lock after ${key}`).toBeNull();
        }
        // And walking takes the mouse back once neither is open.
        await c.page.keyboard.press('Escape');
        await c.page.mouse.click(640, 420);
        await expect.poll(locked, { timeout: UI }).toBe('view');
        await c.close();
    });
