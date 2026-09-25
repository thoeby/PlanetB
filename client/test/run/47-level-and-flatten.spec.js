// Story 47 — B levels a pad to his house's floor, and lays a terrace that
// drains (EDT.8, PLAN-editors.md ideas 11 and 12).
//
// Level aims at a height: typed, Alt-clicked off the ground, or the floor of
// something standing on the land — the thing he built in story 5. Flatten
// makes a plane through where the stroke began, falling a few percent the way
// its arrow points.

import { test, expect, UI } from './players.js';
import { ben, heightUnder, pointOfHisLand, shapeHisLand, shot } from './editors.js';

test.setTimeout(600_000);

async function hold(b, at, ms, { alt = false } = {}) {
    await b.page.mouse.move(at.x, at.y);
    if (alt) await b.page.keyboard.down('Alt');
    await b.page.mouse.down();
    await b.page.waitForTimeout(ms);
    await b.page.mouse.up();
    if (alt) await b.page.keyboard.up('Alt');
}

// The screen point a little way east or west of a ground point.
const beside = (b, g, metres) => b.page.evaluate(({ p, m }) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const lon = p.lon + m / (111320 * Math.cos(p.lat * Math.PI / 180));
    const s = sw.camera.camera.worldToScreen(bp.toScene(lon, p.lat, bp.heightAt(lon, p.lat)));
    return { x: s.x, y: s.y, lon, lat: p.lat };
}, { p: g, m: metres });

async function toTheFloor(b, at) {
    await b.page.keyboard.press('l');
    await expect(b.page.locator('.sc-opt-name')).toHaveText('Level');
    const floor = b.page.locator('.sc-floor');
    await expect(floor.locator('option')).not.toHaveCount(1, { timeout: UI });
    const h = Number(await floor.locator('option').nth(1).getAttribute('value'));
    await floor.selectOption({ index: 1 });
    await expect(b.page.locator('.sc-target')).toHaveValue(h.toFixed(1));
    await b.page.locator('.sc-strength').fill('8');
    await b.page.locator('.sc-strength').dispatchEvent('change');
    await hold(b, at, 2500);
    const got = await heightUnder(b, at);
    expect(Math.abs(got.clay - h), `the pad is at the floor, ${h} m`).toBeLessThan(0.15);
    await shot(b, testInfo_(b), 'story-47-level');
}

// The shot wants the test's info; kept on the player so the steps stay short.
const testInfo_ = (b) => b.testInfo;

async function altPick(b, at) {
    await hold(b, at, 100, { alt: true });
    const got = await heightUnder(b, at);
    await expect(b.page.locator('.sc-status')).toContainText('levelling to');
    expect(Number(await b.page.locator('.sc-target').inputValue()))
        .toBeCloseTo(got.clay, 0);
}

async function terrace(b, at) {
    await b.page.keyboard.press('g');
    await expect(b.page.locator('.sc-opt-name')).toHaveText('Flatten');
    await b.page.locator('.sc-fall').fill('5');
    await b.page.locator('.sc-fall').dispatchEvent('change');
    await b.page.locator('.sc-dir').fill('90');
    await b.page.locator('.sc-dir').dispatchEvent('change');
    await b.page.locator('.sc-size').fill('40');
    await b.page.locator('.sc-size').dispatchEvent('change');
    await hold(b, at, 3000);
    const west = await beside(b, at, -6);
    const east = await beside(b, at, 6);
    const w = (await heightUnder(b, west)).clay;
    const e = (await heightUnder(b, east)).clay;
    expect(w - e, 'twelve metres at 5 % falls about 0.6 m to the east')
        .toBeGreaterThan(0.35);
    expect(w - e).toBeLessThan(0.85);
}

test('story 47 — a pad at the house floor, a height off the ground, a terrace that drains',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        b.testInfo = testInfo;
        await shapeHisLand(b);
        const at = await pointOfHisLand(b);
        await test.step('Level to the floor of the thing he built', () => toTheFloor(b, at));
        await test.step('Alt-click takes the height off the ground', () => altPick(b, at));
        await test.step('Flatten with a fall drains to the east', async () => {
            const other = await beside(b, at, -60);
            await terrace(b, other);
        });
        await b.close();
    });
