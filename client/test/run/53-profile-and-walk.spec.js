// Story 53 — B reads his road's profile and walks it (EDT.16,
// PLAN-editors.md ideas 21 and 25).
//
// Selecting the road opens its profile along the bottom: height along its
// length, red where it climbs past what a road of its kind may, ticks where
// the ground falls too fast across it. Clicking the strip takes the camera
// there. F walks the road at eye height; Esc brings him back over the land
// where he was.

import { test, expect, UI } from './players.js';
import { ben, cameraOf, linesOnHisLand, shot } from './editors.js';

test.setTimeout(600_000);

const roadOnScreen = (b) => b.page.evaluate(async () => {
    const sw = window.splatworld;
    const { curveOf } = await import('./js/lines.js');
    const c = curveOf(sw.lines.lines().live[0]);
    const p = c[Math.floor(c.length / 2)];
    const bp = sw.blueprint;
    const s = sw.camera.camera.worldToScreen(bp.toScene(p.lon, p.lat, bp.heightAt(p.lon, p.lat)));
    return { x: s.x, y: s.y };
});

async function profile(b) {
    await b.page.keyboard.press('v');
    const p = await roadOnScreen(b);
    await b.page.mouse.move(p.x, p.y);
    for (let n = 0; n < 6; n++) await b.page.mouse.wheel(0, -300);
    const q = await roadOnScreen(b);
    await b.page.mouse.click(q.x, q.y);
    const strip = b.page.locator('#profile-strip');
    await expect(strip).toBeVisible({ timeout: UI });
    await expect(strip.locator('.ps-title')).toHaveText(/highway · residential · \d+ m/);
    await expect(strip.locator('.ps-says')).toContainText('max 12 %');
    const was = await cameraOf(b);
    const c = await strip.locator('canvas').boundingBox();
    await b.page.mouse.move(c.x + c.width * 0.2, c.y + c.height / 2, { steps: 2 });
    await b.page.mouse.click(c.x + c.width * 0.2, c.y + c.height / 2);
    const now = await cameraOf(b);
    expect(Math.hypot(now.x - was.x, now.z - was.z), 'the click went there').toBeGreaterThan(1);
}

async function walk(b) {
    const before = await cameraOf(b);
    await b.page.keyboard.press('f');
    await expect(b.page.locator('.ln-status')).toContainText('walking it');
    await b.page.waitForTimeout(800);
    const eye = await b.page.evaluate(() => {
        const sw = window.splatworld;
        const p = sw.camera.getPosition();
        const g = sw.blueprint.toGeo(p);
        return { above: g.h - sw.blueprint.heightAt(g.lon, g.lat), x: p.x, z: p.z };
    });
    expect(eye.above, 'at eye height').toBeGreaterThan(1.2);
    expect(eye.above).toBeLessThan(2.4);
    await b.page.waitForTimeout(1500);
    const later = await cameraOf(b);
    expect(Math.hypot(later.x - eye.x, later.z - eye.z), 'and walking').toBeGreaterThan(0.5);
    await b.page.keyboard.press('Escape');
    await expect(b.page.locator('.ln-status')).toHaveText('back over the land');
    await expect(b.page.locator('#panel')).toBeVisible();
    const back = await cameraOf(b);
    expect(Math.hypot(back.x - before.x, back.y - before.y, back.z - before.z)).toBeLessThan(0.5);
}

test('story 53 — the road’s profile, a click on it, and walking it',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await linesOnHisLand(b);
        await test.step('selecting the road shows its profile', () => profile(b));
        await shot(b, testInfo, 'story-53-profile');
        await test.step('F walks it, Esc comes back', () => walk(b));
        await b.close();
    });
