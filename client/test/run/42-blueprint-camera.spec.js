// Story 42 — B moves round his field in Blueprint (EDT.3, PLAN-editors.md
// idea 8 and §2.1).
//
// The camera orbits a point on the ground: the wheel goes in towards the
// pointer, the right button drags an orbit, it never looks flatter than 30°,
// O swaps to a top-down orthographic view and back, the hand drags the land,
// and Zoom to land frames it again. Closing Blueprint hands the camera back
// to the player where he left it.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand, cameraOf, drag } from './editors.js';

test.setTimeout(600_000);

const CENTRE = { x: 640, y: 420 };

const target = (b) => b.page.evaluate(() => ({ ...window.splatworld.bpmode.cam.state.target }));

async function handAndFit(b) {
    const was = await target(b);
    await drag(b, [CENTRE, { x: CENTRE.x - 150, y: CENTRE.y - 80 }]);
    const moved = await target(b);
    expect(Math.abs(moved.lon - was.lon) + Math.abs(moved.lat - was.lat)).toBeGreaterThan(0);
    await b.page.locator('#bp-side .bp-fit').click();
    expect((await cameraOf(b)).pitch).toBe(60);
}

async function wheelIn(b, start) {
    await b.page.mouse.move(CENTRE.x, CENTRE.y);
    await b.page.mouse.wheel(0, -400);
    expect((await cameraOf(b)).distance).toBeLessThan(start.distance);
    await b.page.mouse.wheel(0, 400);
}

// The operator's note on EDT.7: WASD always flies, the middle button orbits,
// and clicking the clay never takes the pointer away.
async function flyAndOrbit(b) {
    const was = await target(b);
    await b.page.mouse.move(CENTRE.x, CENTRE.y);
    await b.page.keyboard.down('w');
    await b.page.waitForTimeout(500);
    await b.page.keyboard.up('w');
    const flown = await target(b);
    expect(Math.abs(flown.lon - was.lon) + Math.abs(flown.lat - was.lat)).toBeGreaterThan(1e-5);
    const yaw = (await cameraOf(b)).yaw;
    await drag(b, [CENTRE, { x: CENTRE.x + 200, y: CENTRE.y }], { button: 'middle' });
    expect((await cameraOf(b)).yaw).not.toBeCloseTo(yaw, 1);
    await b.page.mouse.click(CENTRE.x, CENTRE.y);
    expect(await b.page.evaluate(() => document.pointerLockElement)).toBeNull();
    expect((await cameraOf(b)).on).toBe(true);
}

test('story 42 — B orbits, zooms, looks straight down, and gets his eyes back',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        const eyes = await b.page.evaluate(() => ({ ...window.splatworld.player.position }));
        await blueprintOverHisLand(b, 'pan');
        const start = await cameraOf(b);
        expect(start.on, 'Blueprint has the camera').toBe(true);

        await test.step('the wheel goes in towards the pointer', () => wheelIn(b, start));

        await test.step('the right button orbits, never flatter than 30°', async () => {
            const was = await cameraOf(b);
            await drag(b, [CENTRE, { x: CENTRE.x + 200, y: CENTRE.y + 400 }],
                { button: 'right' });
            const now = await cameraOf(b);
            expect(now.yaw).not.toBeCloseTo(was.yaw, 1);
            expect(now.pitch).toBeGreaterThanOrEqual(30);
            expect(now.pitch).toBeLessThanOrEqual(90);
            await drag(b, [CENTRE, { x: CENTRE.x, y: CENTRE.y - 900 }], { button: 'right' });
            expect((await cameraOf(b)).pitch).toBe(30);
        });

        await test.step('O is straight down and orthographic, and O again is not', async () => {
            await b.page.keyboard.press('o');
            let now = await cameraOf(b);
            expect(now.ortho).toBe(true);
            expect(now.projection).toBe(1);
            await expect(b.page.locator('#bp-side .bp-ortho')).toHaveAttribute('aria-pressed',
                'true', { timeout: UI });
            await b.page.keyboard.press('o');
            now = await cameraOf(b);
            expect(now.ortho).toBe(false);
            expect(now.projection).toBe(0);
        });

        await test.step('the hand drags the land; Zoom to land frames it again',
            () => handAndFit(b));

        await test.step('W flies, the middle button orbits, and a click locks nothing',
            () => flyAndOrbit(b));

        await test.step('closing hands the camera back where the player was', async () => {
            await b.page.evaluate(() => window.splatworld.bpmode.close());
            const player = await b.page.evaluate(() => ({ ...window.splatworld.player.position }));
            expect(Math.hypot(player.x - eyes.x, player.z - eyes.z),
                'the player stood still while Blueprint had the camera').toBeLessThan(0.5);
            // The next frame puts the camera back in his eyes.
            await expect.poll(async () => {
                const now = await cameraOf(b);
                return Math.hypot(now.x - player.x, now.z - player.z);
            }, { timeout: UI }).toBeLessThan(0.5);
            const now = await cameraOf(b);
            expect(now.on).toBe(false);
            expect(now.projection).toBe(0);
        });
        await b.close();
    });
