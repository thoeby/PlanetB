// Story 41 — B reads his field off the clay (EDT.2, PLAN-editors.md ideas 1–2).
//
// Contour lines every two metres, bold every ten, drawn on the mesh; what he
// changed as colour, blue above the elevation and red below, and the part not
// saved yet hatched; a switch for each on the card in the corner, and the card
// remembers them the next time he opens it.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand, shot } from './editors.js';
import { meanColour } from './pixels.js';

test.setTimeout(600_000);

const lines = (b) => b.page.evaluate(() =>
    [...window.splatworld.blueprint.chunks.values()].filter((c) => c.lines).length);

// A mound in the middle of his land, three metres up, not saved: what a stroke
// leaves behind, put there directly so this story is about the colour only.
const mound = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const s = sw.sculpt.shaping();
    const { width, height, data } = s.grid;
    for (let j = Math.floor(height * 0.3); j < height * 0.7; j++) {
        for (let i = Math.floor(width * 0.3); i < width * 0.7; i++) data[j * width + i] += 3;
    }
    sw.blueprint.rebuild(null);
    return [...sw.blueprint.unsaved].reduce((a, v) => a + v, 0);
});

const undoMound = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const s = sw.sculpt.shaping();
    s.grid.data.set(s.saved);
    sw.blueprint.rebuild(null);
});

// Blue where he raised it, and only while the switch is on.
async function changedIsBlue(b, card, testInfo) {
    await card.locator('.bp-sw-changed').check();
    const clip = await b.page.evaluate(() => {
        const sw = window.splatworld;
        const L = sw.blueprint.L;
        const bp = sw.blueprint;
        const p = bp.toScene(L.lon0, L.lat0, bp.heightAt(L.lon0, L.lat0));
        const s = sw.camera.camera.worldToScreen(p);
        return { x: Math.max(0, s.x - 60), y: Math.max(0, s.y - 40),
            width: 120, height: 80 };
    });
    await b.page.waitForTimeout(500);
    const before = meanColour(await b.page.screenshot({ clip }));
    const unsaved = await mound(b);
    expect(unsaved, 'the mound is shaping not yet saved').toBeGreaterThan(0);
    await b.page.waitForTimeout(500);
    const after = meanColour(await b.page.screenshot({ clip }));
    await shot(b, testInfo, 'story-41-changed');
    expect(after[2] - after[0], 'raised ground reads blue')
        .toBeGreaterThan(before[2] - before[0] + 8);
    await card.locator('.bp-sw-changed').uncheck();
    await b.page.waitForTimeout(500);
    const off = meanColour(await b.page.screenshot({ clip }));
    expect(off[2] - off[0], 'and the switch takes the colour off')
        .toBeLessThan(after[2] - after[0] - 8);
    await undoMound(b);
}

test('story 41 — contours, what he changed, and switches that stay switched',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await blueprintOverHisLand(b);
        const card = b.page.locator('#bp-side');

        await test.step('contour lines are on the mesh, and the switch takes them off',
            async () => {
                await expect(card.locator('.bp-sw-contours')).toBeChecked();
                expect(await lines(b), 'contours are drawn per chunk').toBeGreaterThan(0);
                await card.locator('.bp-sw-contours').uncheck();
                expect(await lines(b)).toBe(0);
                await card.locator('.bp-sw-grid').check();
                expect(await lines(b), 'the 5 m grid is lines too').toBeGreaterThan(0);
                await card.locator('.bp-sw-grid').uncheck();
                await card.locator('.bp-sw-contours').check();
            });

        await test.step('what he changed is blue, and unsaved is marked',
            () => changedIsBlue(b, card, testInfo));

        await test.step('slopes over a limit are marked when asked', async () => {
            await card.locator('.bp-num-steepAt').fill('10');
            await card.locator('.bp-num-steepAt').dispatchEvent('change');
            await card.locator('.bp-sw-steep').check();
            const on = await b.page.evaluate(() => window.splatworld.blueprint.overlays);
            expect(on.steep).toBe(true);
            expect(on.steepAt).toBe(10);
        });

        await test.step('the switches are his, and stay as he left them', async () => {
            await card.locator('.bp-sw-contours').uncheck();
            await b.page.reload();
            await b.page.waitForFunction(() => Boolean(window.splatworld?.bpmode), null,
                { timeout: 120000 });
            await blueprintOverHisLand(b);
            await expect(card.locator('.bp-sw-contours')).not.toBeChecked({ timeout: UI });
            await expect(card.locator('.bp-sw-steep')).toBeChecked();
            await card.locator('.bp-sw-contours').check();
            await card.locator('.bp-sw-steep').uncheck();
            await card.locator('.bp-sw-changed').check();
        });
        await b.close();
    });
