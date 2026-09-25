// Story 43 — the ground says what it is, at the pointer (EDT.4,
// PLAN-editors.md idea 4, idea 5 and §3 rule 3).
//
// A small box follows the pointer with the ground's height, how far it is off
// the elevation and its slope; a two-word tag says what state the pointer is
// in — "not your land" past his boundary, "no ground" over the sky. Holding
// Tab brings the splats back over the clay for as long as it is held, and
// does not open the apps drawer while it does.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand } from './editors.js';

test.setTimeout(600_000);

// Where on the screen a point of the ground is: a vertex inside his land near
// its middle, or one a few hundred metres past its eastern edge.
const screenAt = (b, where) => b.page.evaluate((w) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const L = bp.L;
    let lon = L.lon0;
    let lat = L.lat0;
    if (w === 'inside') {
        let best = null;
        for (let k = 0; k < bp.inside.length; k++) {
            if (!bp.inside[k]) continue;
            const i = k % L.cols;
            const j = Math.floor(k / L.cols);
            const d = Math.hypot(i - L.cols / 2, j - L.rows / 2);
            if (!best || d < best.d) best = { d, i, j };
        }
        lon = L.bbox[0] + best.i * L.dLon;
        lat = L.bbox[3] - best.j * L.dLat;
        const p = bp.toScene(lon, lat, bp.heightAt(lon, lat));
        const s = sw.camera.camera.worldToScreen(p);
        return { x: s.x, y: s.y };
    }
    // Off the land a little way each side in turn, the first that is on the
    // open part of the screen rather than under a panel.
    const tries = [[0, -150 / 110540], [0, 150 / 110540], [-200 / L.mLon, 0],
        [200 / L.mLon, 0]];
    const s = bp.shaping;
    for (const [dLon, dLat] of tries) {
        const x = dLon ? (dLon < 0 ? L.bbox[0] : L.bbox[2]) + dLon : L.lon0;
        const y = dLat ? (dLat < 0 ? L.bbox[1] : L.bbox[3]) + dLat : L.lat0;
        if (s.inside(x, y)) continue;
        const q = sw.camera.camera.worldToScreen(bp.toScene(x, y, bp.heightAt(x, y)));
        if (q.x > 560 && q.x < 1000 && q.y > 170 && q.y < 680) return { x: q.x, y: q.y };
    }
    return null;
}, where);

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
                cam.update();
            });
            await b.page.mouse.move(800, 200, { steps: 4 });
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
