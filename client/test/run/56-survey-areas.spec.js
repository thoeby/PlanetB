// Story 56 — Areas are drawn in Survey (EDT.19, PLAN-editors.md §2.4, D1).
//
// Survey has three parts now: Parcels, Areas and Requests. Areas is a map in
// the page, not the old edit.html: the world's hillshade, his land lit and
// everybody else's dimmed, and the lines he drew in Build read-only — a click
// on one says where it is edited.

import { test, expect, UI } from './players.js';
import { areasOfHisLand, ben, onTheMap, shot } from './editors.js';

test.setTimeout(600_000);

test('story 56 — Survey opens Areas, a map of his land with his lines on it',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await test.step('Survey’s parts are Parcels, Areas and Requests', async () => {
            await areasOfHisLand(b);
            await expect(b.page.locator('#panel .parts .part:not([hidden])'))
                .toHaveText([/^Parcels/, /^Areas/, /^Requests/]);
        });
        await test.step('his land is on it, lit, and his road is there', async () => {
            const got = await b.page.evaluate(() => {
                const s = window.splatworld.surveyAreas.state;
                return { lands: s.m.sources.lands.getFeatures().filter((f) => f.get('mine')).length,
                    lines: s.m.sources.lines.getFeatures().length };
            });
            expect(got.lands).toBeGreaterThan(0);
            expect(got.lines).toBeGreaterThan(0);
            await expect(b.page.locator('.ar-status')).toContainText('Ben’s field');
        });
        await test.step('a click on the road says it is edited in Build', async () => {
            const n = await b.page.evaluate(() => {
                const f = window.splatworld.surveyAreas.state.lines[0];
                const c = f.geom.coordinates;
                return c[Math.floor(c.length / 2)];
            });
            const p = await onTheMap(b, n[0], n[1]);
            await b.page.mouse.click(p.x, p.y);
            await expect(b.page.locator('.ar-tag')).toHaveText('Edit in Build → Lines',
                { timeout: UI });
            await shot(b, testInfo, 'story-56-areas');
        });
        await test.step('Requests lists who is waiting', async () => {
            await b.page.locator('#panel .parts .part[data-tab="Requests"]').click();
            await expect(b.page.locator('.rq-list')).toBeVisible({ timeout: UI });
        });
        await b.close();
    });
