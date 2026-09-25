// Story 67 — one forest, not two; a pond cut out of it (EDT.21,
// PLAN-editors.md idea 30).
//
// B paints more forest over the wood he saved in story 66 and names it; he
// draws a pond inside it. On Save the two forests are one row and the pond is
// a hole in it, and the save says so in one line: "forest saved · merged with
// 1". The form beside the map is the vocabulary's fields for the area in hand.

import { test, expect, UI } from './players.js';
import { areasInTheWorld, areasOfHisLand, ben, onTheMap, shot } from './editors.js';

test.setTimeout(600_000);

// Metres east and north of his land's east edge, middle, on the map.
const at = async (b, east, north) => {
    const p = await b.page.evaluate(({ e, n }) => {
        const bb = window.splatworld.surveyAreas.state.land.bbox;
        const lat = (bb.south + bb.north) / 2;
        return { lon: bb.east + e / (111320 * Math.cos(lat * Math.PI / 180)),
            lat: lat + n / 110540 };
    }, { e: east, n: north });
    return onTheMap(b, p.lon, p.lat);
};

async function pick(b, kind, words) {
    await b.page.locator('.ar-left .kp-search').fill(words);
    await b.page.locator(`.ar-left .kp-kind[data-kind="${kind}"]`).click();
    await b.page.locator('.ar-left .kp-search').fill('');
}

async function moreForest(b) {
    await pick(b, 'landuse:forest', 'forest');
    await expect(b.page.locator('.ar-which')).toContainText('landuse · forest');
    await b.page.locator('.ar-tool-paint').click();
    await b.page.locator('.ar-size').fill('40');
    await b.page.locator('.ar-size').dispatchEvent('change');
    const px = [];
    for (let e = -260; e <= -120; e += 10) px.push(await at(b, e, 5));
    await b.page.mouse.move(px[0].x, px[0].y);
    await b.page.mouse.down();
    for (const p of px.slice(1)) await b.page.mouse.move(p.x, p.y, { steps: 2 });
    await b.page.mouse.up();
    await expect(b.page.locator('.ar-status')).toContainText('landuse · forest drawn',
        { timeout: UI });
    // The form is the new area's: its class set, and a name to give it.
    await expect(b.page.locator('.ar-fields .ar-field-landuse')).toHaveValue('forest');
    await b.page.locator('.ar-fields .ar-field-name').fill('Oak wood');
    await b.page.locator('.ar-fields .ar-field-name').dispatchEvent('change');
}

async function pond(b) {
    await pick(b, 'natural:water', 'water');
    await b.page.locator('.ar-tool-draw').click();
    const px = [];
    for (const [e, n] of [[-100, -8], [-80, -8], [-80, 8], [-100, 8]]) px.push(await at(b, e, n));
    for (const p of px) {
        await b.page.mouse.click(p.x, p.y);
        await b.page.waitForTimeout(250);
    }
    await b.page.mouse.click(px[0].x, px[0].y);
    await expect(b.page.locator('.ar-status')).toContainText('natural · water drawn',
        { timeout: UI });
}

test('story 67 — two forests saved as one, and a pond cut out of it',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await areasOfHisLand(b);
        await test.step('he paints more forest over his wood, and names it',
            () => moreForest(b));
        await test.step('he draws a pond inside the wood', () => pond(b));
        await shot(b, testInfo, 'story-58-before-save');
        await test.step('Save: one forest with a hole, said in one line', async () => {
            await b.page.locator('.ar-save').click();
            await expect(b.page.locator('.ar-said')).toContainText('forest saved · merged with 1',
                { timeout: UI });
            await expect(b.page.locator('.ar-said')).toContainText('water saved · cut 1');
            const got = await areasInTheWorld(b);
            const forests = got.rows.filter((r) => r.props.landuse === 'forest');
            expect(forests, 'one forest row').toHaveLength(1);
            expect(forests[0].props.name).toBe('Oak wood');
            const polys = forests[0].geom.type === 'Polygon' ? [forests[0].geom.coordinates]
                : forests[0].geom.coordinates;
            expect(polys.some((p) => p.length === 2), 'the pond is a hole in it').toBe(true);
            expect(got.rows.some((r) => r.props.natural === 'water')).toBe(true);
        });
        await b.close();
    });
