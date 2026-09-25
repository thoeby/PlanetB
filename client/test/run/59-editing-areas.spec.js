// Story 59 — B moves a corner of his meadow, and erases his pond (EDT.22,
// PLAN-editors.md §2.4).
//
// Edit takes an area in hand with a click; its corners drag, snapping to the
// other areas and his land's edge. Erase takes an area away with a click, and
// Ctrl-Z brings it back. Saved, the meadow's row has its corner where he left
// it, and the pond is gone from the world.

import { test, expect, UI } from './players.js';
import { areasInTheWorld, areasOfHisLand, ben, onTheMap, shot } from './editors.js';

test.setTimeout(600_000);

const EAST = 1 / 110540;

// Metres east and north of his land's east edge, middle: degrees and pixels.
const at = async (b, east, north) => {
    const p = await b.page.evaluate(({ e, n }) => {
        const bb = window.splatworld.surveyAreas.state.land.bbox;
        const lat = (bb.south + bb.north) / 2;
        return { lon: bb.east + e / (111320 * Math.cos(lat * Math.PI / 180)),
            lat: lat + n / 110540 };
    }, { e: east, n: north });
    return { ...p, ...(await onTheMap(b, p.lon, p.lat)) };
};

// In close over the meadow, as a person would before dragging a corner.
async function closeIn(b, out = false) {
    const m = await at(b, -240, 80);
    await b.page.mouse.move(m.x, m.y);
    for (let n = 0; n < 3; n++) {
        await b.page.mouse.wheel(0, out ? 300 : -300);
        await b.page.waitForTimeout(400);
    }
}

async function moveACorner(b) {
    await closeIn(b);
    await b.page.locator('.ar-tool-edit').click();
    const inside = await at(b, -260, 90);
    await b.page.mouse.click(inside.x, inside.y);
    await expect(b.page.locator('.ar-status')).toContainText('meadow in hand', { timeout: UI });
    const corner = await at(b, -220, 60);
    const there = await at(b, -190, 45);
    await b.page.mouse.move(corner.x, corner.y);
    await b.page.mouse.down();
    await b.page.mouse.move(there.x, there.y, { steps: 8 });
    await b.page.mouse.up();
    await expect(b.page.locator('.ar-status')).toContainText('meadow changed', { timeout: UI });
    return there;
}

async function eraseThePond(b) {
    await closeIn(b, true);
    await b.page.locator('.ar-tool-erase').click();
    const pond = await at(b, -90, 0);
    await b.page.mouse.click(pond.x, pond.y);
    await expect(b.page.locator('.ar-status')).toContainText('water erased', { timeout: UI });
    await b.page.keyboard.press('Control+z');
    await expect(b.page.locator('.ar-status')).toHaveText('undone');
    await b.page.mouse.click(pond.x, pond.y);
    await expect(b.page.locator('.ar-status')).toContainText('water erased', { timeout: UI });
}

test('story 59 — a corner moved, a pond erased and brought back and erased, saved',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await areasOfHisLand(b);
        const there = await test.step('he drags a corner of his meadow', () => moveACorner(b));
        await test.step('he erases the pond; Ctrl-Z brings it back', () => eraseThePond(b));
        await shot(b, testInfo, 'story-59-edited');
        await test.step('saved: the corner where he left it, and no pond', async () => {
            await b.page.locator('.ar-save').click();
            await expect(b.page.locator('.ar-said')).toContainText('meadow saved', { timeout: UI });
            const got = await areasInTheWorld(b);
            const meadow = got.rows.find((r) => r.props.landuse === 'meadow');
            const ring = meadow.geom.type === 'Polygon' ? meadow.geom.coordinates[0]
                : meadow.geom.coordinates[0][0];
            const near = Math.min(...ring.map(([lon, lat]) => Math.hypot(
                (lon - there.lon) * Math.cos(lat * Math.PI / 180), lat - there.lat)));
            expect(near / EAST, 'a corner within a metre of where he let go').toBeLessThan(1);
            expect(got.rows.some((r) => r.props.natural === 'water'), 'no pond').toBe(false);
        });
        await b.close();
    });
