// Story 66 — B paints a forest, and draws a meadow (EDT.20, PLAN-editors.md
// ideas 28 and 29).
//
// Paint is a round brush whose strokes become one area. He paints a wood that
// runs off the edge of his field; it is clipped to his land when he lets go,
// never refused. Draw clicks corners and closes on the first. Saved, the
// world holds a landuse=forest whose every corner is on his land.

import { test, expect, UI } from './players.js';
import { areasInTheWorld, areasOfHisLand, ben, onTheMap, shot } from './editors.js';

test.setTimeout(600_000);

// Points in metres east and north of his land's east edge, middle.
const fromEdge = (b, east, north) => b.page.evaluate(({ e, n }) => {
    const bb = window.splatworld.surveyAreas.state.land.bbox;
    const lat = (bb.south + bb.north) / 2;
    return { lon: bb.east + e / (111320 * Math.cos(lat * Math.PI / 180)), lat: lat + n / 110540 };
}, { e: east, n: north });

async function paint(b) {
    await b.page.locator('.ar-left .kp-search').fill('forest');
    await b.page.locator('.ar-left .kp-kind[data-kind="landuse:forest"]').click();
    await b.page.locator('.ar-left .kp-search').fill('');
    await b.page.locator('.ar-tool-paint').click();
    await expect(b.page.locator('.ar-tool-paint')).toHaveAttribute('aria-pressed', 'true');
    await b.page.locator('.ar-size').fill('40');
    await b.page.locator('.ar-size').dispatchEvent('change');
    const pts = [];
    for (let e = -160; e <= 60; e += 10) pts.push(await fromEdge(b, e, 0));
    const px = [];
    for (const p of pts) px.push(await onTheMap(b, p.lon, p.lat));
    await b.page.mouse.move(px[0].x, px[0].y);
    await b.page.mouse.down();
    for (const p of px.slice(1)) await b.page.mouse.move(p.x, p.y, { steps: 2 });
    await b.page.mouse.up();
    await expect(b.page.locator('.ar-status')).toContainText('landuse · forest drawn',
        { timeout: UI });
    await expect(b.page.locator('.ar-status')).toContainText('clipped to your land');
}

async function draw(b) {
    await b.page.locator('.ar-left .kp-kind[data-kind="landuse:meadow"]').click();
    await b.page.locator('.ar-tool-draw').click();
    const corners = [[-300, 60], [-220, 60], [-220, 120], [-300, 120]];
    const px = [];
    for (const [e, n] of corners) {
        const p = await fromEdge(b, e, n);
        px.push(await onTheMap(b, p.lon, p.lat));
    }
    for (const p of px) {
        await b.page.mouse.click(p.x, p.y);
        await b.page.waitForTimeout(250);
    }
    await b.page.mouse.click(px[0].x, px[0].y);
    await expect(b.page.locator('.ar-status')).toContainText('landuse · meadow drawn',
        { timeout: UI });
}

test('story 66 — a forest painted over the edge is clipped; a meadow drawn; saved',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await areasOfHisLand(b);
        await test.step('he paints a forest that runs off his land', () => paint(b));
        await test.step('he draws a meadow corner by corner', () => draw(b));
        await shot(b, testInfo, 'story-57-painted');
        await test.step('saved, the forest is inside his land', async () => {
            await b.page.locator('.ar-save').click();
            await expect(b.page.locator('.ar-said')).toContainText('forest saved', { timeout: UI });
            await expect(b.page.locator('.ar-said')).toContainText('meadow saved');
            const got = await areasInTheWorld(b);
            const forest = got.rows.find((r) => r.props.landuse === 'forest');
            expect(forest, 'a forest row').toBeTruthy();
            const ring = forest.geom.type === 'Polygon' ? forest.geom.coordinates[0]
                : forest.geom.coordinates[0][0];
            const slack = 1e-6;
            for (const [lon] of ring) expect(lon).toBeLessThanOrEqual(got.land.east + slack);
            expect(got.rows.some((r) => r.props.landuse === 'meadow')).toBe(true);
        });
        await b.close();
    });
