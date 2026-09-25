// Story 65 — Areas are drawn in Survey (EDT.19, PLAN-editors.md §2.4, D1).
//
// Survey has three parts now: Parcels, Areas and Requests. Areas is a map in
// the page, not the old edit.html: the world's hillshade, his land lit and
// everybody else's dimmed, and the lines he drew in Build read-only — a click
// on one says where it is edited.

import { test, expect, UI } from './players.js';
import { areasOfHisLand, ben, onTheMap, shot } from './editors.js';

test.setTimeout(600_000);

test('story 65 — Survey opens Areas, a map of his land with his lines on it',
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
            // The middle of a line that is on the map, not past its edge.
            const n = await b.page.evaluate(() => {
                const s = window.splatworld.surveyAreas.state;
                const r = s.m.map.getTargetElement().getBoundingClientRect();
                const mid = (f) => f.geom.coordinates[Math.floor(f.geom.coordinates.length / 2)];
                const seen = (c) => {
                    const px = s.m.map.getPixelFromCoordinate(s.m.ol.proj.fromLonLat(c));
                    return px && px[0] > 20 && px[1] > 20 && px[0] < r.width - 20
                        && px[1] < r.height - 20;
                };
                return mid(s.lines.find((f) => seen(mid(f))) ?? s.lines[0]);
            });
            // Clicked again until the map has settled where it was framed: a
            // click while the view still moves lands somewhere else.
            await expect(async () => {
                const p = await onTheMap(b, n[0], n[1]);
                await b.page.mouse.click(p.x, p.y);
                await expect(b.page.locator('.ar-tag')).toHaveText('Edit in Build → Lines',
                    { timeout: 2000 });
            }).toPass({ timeout: UI });
            await shot(b, testInfo, 'story-56-areas');
        });
        await test.step('Requests lists who is waiting', async () => {
            await b.page.locator('#panel .parts .part[data-tab="Requests"]').click();
            await expect(b.page.locator('.rq-list')).toBeVisible({ timeout: UI });
        });
        await b.close();
    });
