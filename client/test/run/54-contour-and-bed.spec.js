// Story 54 — a path along the contour, and a bed under the road (EDT.17,
// PLAN-editors.md ideas 22 and 23, D3).
//
// Holding Alt while drawing keeps each new node at the first node's height,
// walked along the slope — a path across the hillside that needs no shaping.
// Lay bed on his road opens Shape with Along line in hand and the road, its
// width and its gradient filled in: he lays it, undoes it, lays it again and
// saves. That is the only place a line touches the ground.

import { test, expect, UI } from './players.js';
import { ben, linesOnHisLand, shot } from './editors.js';

test.setTimeout(600_000);

// The steepest vertex of his land, and a point 25 m up its slope, on screen.
const onTheSlope = (b) => b.page.evaluate(async () => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const L = bp.L;
    const { slopeAt } = await import('./lib/bpgrid.js');
    let best = null;
    for (let j = 2; j < L.rows - 2; j += 2) {
        for (let i = 2; i < L.cols - 2; i += 2) {
            if (!bp.inside[j * L.cols + i]) continue;
            const s = slopeAt(L, bp.heights, i, j);
            if (s < 45 && (!best || s > best.s)) best = { s, i, j };
        }
    }
    const lon = L.bbox[0] + best.i * L.dLon;
    const lat = L.bbox[3] - best.j * L.dLat;
    const h = (a, b) => bp.heightAt(a, b);
    const m = 111320 * Math.cos(lat * Math.PI / 180);
    const gx = h(lon + 1 / m, lat) - h(lon - 1 / m, lat);
    const gz = h(lon, lat + 1 / 110540) - h(lon, lat - 1 / 110540);
    const d = Math.hypot(gx, gz) || 1;
    const up = { lon: lon + (gx / d) * 25 / m, lat: lat + (gz / d) * 25 / 110540 };
    const scr = (p) => sw.camera.camera.worldToScreen(bp.toScene(p.lon, p.lat, h(p.lon, p.lat)));
    return { a: { ...scr({ lon, lat }), lon, lat }, b: { ...scr(up), ...up } };
});

async function alongTheContour(b) {
    const s = await onTheSlope(b);
    await b.page.mouse.move(s.a.x, s.a.y);
    for (let n = 0; n < 7; n++) await b.page.mouse.wheel(0, -300);
    const t = await onTheSlope(b);
    await b.page.keyboard.press('d');
    await b.page.mouse.click(t.a.x, t.a.y);
    await b.page.keyboard.down('Alt');
    await b.page.mouse.move(t.b.x, t.b.y, { steps: 3 });
    await expect(b.page.locator('.bp-tag')).toHaveText('follow contour', { timeout: UI });
    await b.page.mouse.click(t.b.x, t.b.y);
    await b.page.keyboard.up('Alt');
    const got = await b.page.evaluate(() => {
        const sw = window.splatworld;
        const [p, q] = sw.lines.state.drawing.nodes;
        return { a: sw.blueprint.heightAt(p.lon, p.lat), b: sw.blueprint.heightAt(q.lon, q.lat) };
    });
    expect(Math.abs(got.a - got.b), 'the second node is at the first one’s height')
        .toBeLessThan(0.3);
    await b.page.keyboard.press('Escape');
    await b.page.keyboard.press('Escape');
    await b.page.locator('#bp-side .bp-fit').click();
}

async function theBed(b) {
    await b.page.keyboard.press('v');
    const p = await b.page.evaluate(async () => {
        const sw = window.splatworld;
        const { curveOf } = await import('./js/lines.js');
        const c = curveOf(sw.lines.lines().live[0]);
        const m = c[Math.floor(c.length / 2)];
        const bp = sw.blueprint;
        return sw.camera.camera.worldToScreen(bp.toScene(m.lon, m.lat, bp.heightAt(m.lon, m.lat)));
    });
    await b.page.mouse.click(p.x, p.y);
    await b.page.locator('.ln-bed').click();
    await expect(b.page.locator('#panel header .title')).toHaveText('Shape', { timeout: UI });
    await expect(b.page.locator('.sc-opt-name')).toHaveText('Along line', { timeout: UI });
    await expect(b.page.locator('.sc-status')).toContainText('is loaded');
    await expect(b.page.locator('.sc-width')).toHaveValue('5');
    await b.page.locator('.sc-apply').click();
    await expect(b.page.locator('.sc-status')).toContainText('bed laid along', { timeout: UI });
    await expect(b.page.locator('.sh-history .sh-stroke').first()).toContainText('Road bed');
    await b.page.keyboard.press('Control+z');
    await expect(b.page.locator('.sc-status')).toHaveText('undone');
    await b.page.locator('.sc-apply').click();
    await expect(b.page.locator('.sc-status')).toContainText('bed laid along', { timeout: UI });
    await b.page.locator('.sc-save').click();
    await expect(b.page.locator('.sc-status')).toContainText(/ground saved · \d+ tiles? changed/,
        { timeout: UI });
}

test('story 54 — a path along the contour, and a bed laid, undone, laid and saved',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await linesOnHisLand(b);
        await test.step('Alt keeps a new node at the first one’s height',
            () => alongTheContour(b));
        await test.step('Lay bed, undo, lay again, save', () => theBed(b));
        await shot(b, testInfo, 'story-54-bed');
        await b.close();
    });
