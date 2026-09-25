// Story 51 — B's nodes snap to what matters (EDT.14, PLAN-editors.md idea 19
// and D5).
//
// Near the end of the road he drew in story 50 the pointer says "snapped:
// road end" and a click starts exactly there. Near his boundary it snaps to
// the boundary; far into somebody else's ground it is refused, "not your
// land". Ctrl holds the new segment to 15° steps, and with the grid on a
// node lands on the metre.

import { test, expect, UI } from './players.js';
import { ben, linesOnHisLand, offsetOnScreen, pointOfHisLand } from './editors.js';

test.setTimeout(600_000);

const tag = (b) => b.page.locator('.bp-tag');

const endOnScreen = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const road = sw.lines.lines().live[0];
    const n = road.nodes.at(-1);
    const bp = sw.blueprint;
    const s = sw.camera.camera.worldToScreen(bp.toScene(n.lon, n.lat, bp.heightAt(n.lon, n.lat)));
    return { x: s.x, y: s.y, lon: n.lon, lat: n.lat };
});

// A point of the land's boundary on screen, and one well past it.
const boundary = (b, out) => b.page.evaluate((o) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const a = sw.lines.lines().area.bbox;
    const lat = (a.south + a.north) / 2;
    const lon = a.east + o / (111320 * Math.cos(lat * Math.PI / 180));
    const s = sw.camera.camera.worldToScreen(bp.toScene(lon, lat, bp.heightAt(lon, lat)));
    return { x: s.x, y: s.y };
}, out);

async function roadEnd(b) {
    const end = await endOnScreen(b);
    await b.page.mouse.move(end.x + 3, end.y + 2, { steps: 3 });
    await expect(tag(b)).toHaveText('snapped: road end', { timeout: UI });
    await b.page.mouse.click(end.x + 3, end.y + 2);
    const first = await b.page.evaluate(() => window.splatworld.lines.state.drawing.nodes[0]);
    expect(first.lon).toBe(end.lon);
    expect(first.lat).toBe(end.lat);
}

async function theBoundary(b) {
    // Zoomed in so a pixel is a small part of a metre and the edge is clear.
    const edge = await boundary(b, -1);
    await b.page.mouse.move(edge.x, edge.y);
    for (let n = 0; n < 4; n++) await b.page.mouse.wheel(0, -300);
    const inside = await boundary(b, -2);
    await b.page.mouse.move(inside.x, inside.y, { steps: 3 });
    await expect(tag(b)).toHaveText('snapped: boundary', { timeout: UI });
    const far = await boundary(b, 45);
    await b.page.mouse.move(far.x, far.y, { steps: 3 });
    await expect(tag(b)).toHaveText('not your land', { timeout: UI });
    await b.page.mouse.click(far.x, far.y);
    await expect(b.page.locator('.ln-status')).toContainText('not your land');
    await b.page.locator('#bp-side .bp-fit').click();
}

async function angleAndGrid(b) {
    const at = await pointOfHisLand(b);
    const p = await offsetOnScreen(b, at, -30, 80);
    await b.page.mouse.move(p.x, p.y, { steps: 2 });
    await b.page.keyboard.down('Control');
    await b.page.mouse.move(p.x + 4, p.y + 3, { steps: 2 });
    await expect(tag(b)).toHaveText('snapped: 15°', { timeout: UI });
    await b.page.keyboard.up('Control');
    await b.page.locator('#bp-side .bp-sw-grid').check();
    await b.page.mouse.move(p.x + 1, p.y, { steps: 2 });
    await expect(tag(b)).toHaveText('snapped: grid', { timeout: UI });
    await b.page.locator('#bp-side .bp-sw-grid').uncheck();
}

test('story 51 — a road end, the boundary, not his land, 15° and the grid',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await linesOnHisLand(b);
        await test.step('the end of his road', () => roadEnd(b));
        await test.step('his boundary, and ground that is not his', () => theBoundary(b));
        await test.step('15° with Ctrl, the metre with the grid', () => angleAndGrid(b));
        await b.page.keyboard.press('Escape');
        await b.close();
    });
