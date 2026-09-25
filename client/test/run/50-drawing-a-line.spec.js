// Story 50 — B draws a road (EDT.13, PLAN-editors.md §2.3, ideas 17 and 26).
//
// Lines is the fifth surface and opens on the same clay as Shape. He picks
// "highway · residential" from the kinds, clicks six nodes across his field,
// ends it with Enter and saves. What the world holds is the curve densified —
// a LineStringZ with a point at least every metre — and the six nodes kept in
// props.ctrl, so the handles come back next time.

import { test, expect, UI } from './players.js';
import { ben, linesInTheWorld, linesOnHisLand, offsetOnScreen, pointOfHisLand, shot }
    from './editors.js';

test.setTimeout(600_000);

const NODES = [[-120, -40], [-80, 0], [-40, 20], [0, 10], [40, -20], [90, -30]];

async function sixNodes(b) {
    const at = await pointOfHisLand(b);
    for (const [e, n] of NODES) {
        const p = await offsetOnScreen(b, at, e, n);
        await b.page.mouse.click(p.x, p.y);
        await b.page.waitForTimeout(550);
    }
}

test('story 50 — a road of six nodes, saved as a densified line with its handles',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await test.step('5 opens Lines on the clay', () => linesOnHisLand(b));
        await test.step('he picks a residential road', async () => {
            await b.page.locator('.ln-kinds .kp-search').fill('residential');
            await b.page.locator('.kp-kind[data-kind="highway:residential"]').click();
            await expect(b.page.locator('.kp-kind[data-kind="highway:residential"]'))
                .toHaveAttribute('aria-selected', 'true');
            await b.page.locator('.ln-kinds .kp-search').fill('');
        });
        await test.step('six clicks, and Enter ends it', async () => {
            await sixNodes(b);
            await expect(b.page.locator('.ln-status')).toContainText('6 nodes');
            await shot(b, testInfo, 'story-50-drawing');
            await b.page.keyboard.press('Enter');
            await expect(b.page.locator('.ln-status')).toContainText('highway drawn');
        });
        await test.step('saved, it is a densified LineStringZ with props.ctrl', async () => {
            await b.page.locator('.ln-save').click();
            await expect(b.page.locator('.ln-status')).toHaveText('1 line saved', { timeout: UI });
            const rows = await linesInTheWorld(b);
            expect(rows).toHaveLength(1);
            const [row] = rows;
            expect(row.kind).toBe('highway');
            expect(row.props.highway).toBe('residential');
            expect(row.props.width).toBe(5);
            expect(row.props.ctrl.nodes).toHaveLength(6);
            expect(row.geom.type).toBe('LineString');
            expect(row.geom.coordinates.length, 'a point at least every metre')
                .toBeGreaterThan(200);
            expect(row.geom.coordinates[0]).toHaveLength(3);
            expect(row.geom.coordinates[0][2], 'at the ground’s height').toBeGreaterThan(400);
        });
        await test.step('a held drag is a sketch, simplified to a few nodes', async () => {
            const at = await pointOfHisLand(b);
            const pts = [];
            for (let e = -60; e <= 60; e += 6) {
                pts.push(await offsetOnScreen(b, at, e, 60 + Math.sin(e / 20) * 8));
            }
            await b.page.mouse.move(pts[0].x, pts[0].y);
            await b.page.mouse.down();
            for (const p of pts.slice(1)) await b.page.mouse.move(p.x, p.y, { steps: 2 });
            await b.page.mouse.up();
            const nodes = () => b.page.evaluate(
                () => window.splatworld.lines.state.drawing?.nodes.length);
            const n = await nodes();
            expect(n).toBeGreaterThan(2);
            expect(n).toBeLessThan(pts.length);
            await b.page.keyboard.press('Escape');
            expect(await nodes()).toBe(n - 1);
            await expect(b.page.locator('#lines-tools')).toBeVisible();
        });
        await b.close();
    });
