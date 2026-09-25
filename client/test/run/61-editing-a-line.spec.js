// Story 61 — B edits his road (EDT.15, PLAN-editors.md ideas 18, 20, 24).
//
// With Select in hand he takes the road from story 59, drags a node, drags the
// middle of a segment to put a node there, clicks a node twice to make it a
// corner, widens the road at one node with its handle, splits it with a right
// click, deletes a node, undoes it, and saves. The world holds what he did.

import { test, expect, UI } from './players.js';
import { ben, drag, linesInTheWorld, linesOnHisLand, shot } from './editors.js';

test.setTimeout(600_000);

const road = (b) => b.page.evaluate(() => {
    const l = window.splatworld.lines.state.selected ?? window.splatworld.lines.lines().live[0];
    return { nodes: l.nodes, corner: l.corner, widths: l.props.widths ?? null };
});

// A node of the road, a point between two of them, or a width handle, on screen.
const onScreen = (b, what, i) => b.page.evaluate(async ({ w, k }) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const l = sw.lines.state.selected ?? sw.lines.lines().live[0];
    const { handlesOf } = await import('./js/lineedit.js');
    const { curveOf } = await import('./js/lines.js');
    let p = l.nodes[k];
    if (w === 'handle') p = handlesOf(l)[k];
    if (w === 'curve') {
        const c = curveOf(l);
        p = c[Math.floor(c.length * (k + 0.5) / (l.nodes.length - 1))];
    }
    const s = sw.camera.camera.worldToScreen(bp.toScene(p.lon, p.lat, bp.heightAt(p.lon, p.lat)));
    return { x: s.x, y: s.y };
}, { w: what, k: i });

async function closer(b) {
    const p = await onScreen(b, 'node', 2);
    await b.page.mouse.move(p.x, p.y);
    for (let n = 0; n < 9; n++) await b.page.mouse.wheel(0, -300);
}

async function edits(b) {
    await b.page.keyboard.press('v');
    let p = await onScreen(b, 'node', 2);
    await b.page.mouse.click(p.x, p.y);
    await expect(b.page.locator('.ln-status')).toContainText('highway');
    const was = await road(b);
    p = await onScreen(b, 'node', 2);
    await drag(b, [p, { x: p.x + 30, y: p.y + 20 }]);
    expect((await road(b)).nodes[2]).not.toEqual(was.nodes[2]);
    p = await onScreen(b, 'curve', 3);
    await drag(b, [p, { x: p.x, y: p.y - 25 }]);
    expect((await road(b)).nodes).toHaveLength(7);
    p = await onScreen(b, 'node', 1);
    await b.page.mouse.click(p.x, p.y);
    await b.page.mouse.click(p.x, p.y);
    expect((await road(b)).corner[1]).toBe(true);
    p = await onScreen(b, 'handle', 3);
    await drag(b, [p, { x: p.x + 12, y: p.y - 12 }]);
    const w = (await road(b)).widths;
    expect(w).toHaveLength(7);
    expect(w[3]).toBeGreaterThan(5);
}

async function nodeDeeds(b) {
    const p = await onScreen(b, 'node', 4);
    await b.page.mouse.click(p.x, p.y);
    await b.page.keyboard.press('Delete');
    expect((await road(b)).nodes).toHaveLength(6);
    await b.page.keyboard.press('Control+z');
    expect((await road(b)).nodes).toHaveLength(7);
    const q = await onScreen(b, 'node', 3);
    await b.page.mouse.click(q.x, q.y, { button: 'right' });
    await expect(b.page.locator('#ln-menu')).toBeVisible({ timeout: UI });
    await shot(b, testInfo_.info, 'story-52-menu');
    await b.page.locator('#ln-menu .ln-menu-split').click();
    await expect(b.page.locator('.ln-status')).toHaveText('split in two');
    expect(await b.page.evaluate(() => window.splatworld.lines.lines().live.length)).toBe(2);
}

const testInfo_ = { info: null };

test('story 61 — move, insert, corner, widen, split, delete, undo, save',
    async ({ browser, world }, testInfo) => {
        testInfo_.info = testInfo;
        const b = await ben(browser, world, testInfo);
        await linesOnHisLand(b);
        await closer(b);
        await test.step('select, drag, insert, corner, widen', () => edits(b));
        await test.step('delete a node, undo, split with a right click', () => nodeDeeds(b));
        await test.step('saved, the world has both halves with their handles', async () => {
            await b.page.locator('.ln-save').click();
            await expect(b.page.locator('.ln-status')).toHaveText('2 lines saved', { timeout: UI });
            const rows = await linesInTheWorld(b);
            expect(rows).toHaveLength(2);
            const nodes = rows.map((r) => r.props.ctrl.nodes.length).sort();
            expect(nodes).toEqual([4, 4]);
            expect(rows.some((r) => r.props.ctrl.corner.includes(1))).toBe(true);
            expect(rows.every((r) => Array.isArray(r.props.widths))).toBe(true);
        });
        await b.close();
    });
