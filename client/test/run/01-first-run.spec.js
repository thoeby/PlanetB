// Story 1 — first run (docs/SPEC.md §3.1).
//
// A opens the page over an empty world, makes an account, says who they are,
// points the world at a GeoServer, picks the coverage, and is standing on the
// ground it publishes. Then A walks fifty metres and the ground comes with
// them.
//
// Nothing here is set up in advance. The world this runs against has no
// account, no ground row, and not one DEM tile cut: everything below happens
// through controls on the page.

import { test, expect, open, shows, signUp, UI } from './players.js';
import { differs, variety } from './pixels.js';

// The coverage tools/make-seed-dem.sh cuts: 4 x 4 km around Visp, in Valais.
const CENTRE = { lon: 7.8815, lat: 46.2939 };

// A rectangle of the 3D view with no chrome over it: the panels, the hints and
// the notice all live outside it, so what changes here is the world changing.
const VIEW = { x: 690, y: 120, width: 370, height: 240 };

// "46.2939N 7.8815E · 651 m" — where the player is, as the page says it.
function readCoords(text) {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])\s*·\s*(-?\d+)\s*m/.exec(text ?? '');
    if (!m) return null;
    return {
        lat: Number(m[1]) * (m[2] === 'S' ? -1 : 1),
        lon: Number(m[3]) * (m[4] === 'W' ? -1 : 1),
        height: Number(m[5]),
    };
}

const metresBetween = (a, b) => Math.hypot(
    (a.lat - b.lat) * 111_320,
    (a.lon - b.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180));

async function where(page) {
    const text = await page.locator('#standing .coords').textContent();
    return readCoords(text);
}


async function chooseTheGround(a, geoserverUrl) {
    const { page } = a;
    await test.step('A points the world at their GeoServer', async () => {
        await page.getByPlaceholder('localhost:8080/geoserver').fill(geoserverUrl);
        await page.getByRole('button', { name: 'Connect' }).click();
        // The sentence in the panel, not the label beside the dropdown: a
        // status line that has not changed yet is the state that hid this.
        await expect(page.locator('.gs-status')).toContainText('coverage(s)',
            { timeout: UI });
    });
    await test.step('A picks the coverage the world stands on', async () => {
        const picker = page.locator('select.gs-coverage');
        await expect(picker).toBeEnabled({ timeout: UI });
        const options = await picker.locator('option').allTextContents();
        expect(options.join(' '), 'the elevation is offered by name').toContain('Visp');
        await picker.selectOption({ index: 0 });
        await page.getByRole('button', { name: 'Use this ground' }).click();
        // The page reloads onto the world it now has (3.1 step 3), and it is
        // the world that is loading, not the empty one it opened on.
        await page.waitForURL((url) => !url.hash.startsWith('#at='),
            { timeout: UI });
        await expect(page.locator('canvas#view')).toBeVisible({ timeout: UI });
    });
}

async function standingOnGround(a) {
    const { page } = a;
    // The page reloads onto the world it now has (3.1 step 3).
    await test.step('A is standing on ground nobody owns', async () => {
        await expect(page.locator('#land')).toHaveText('unclaimed ground', { timeout: UI });
        await shows(a, 'nobody owns this');
    });
    await test.step('and the ground is under them, not above', async () => {
        // The ground is cut when somebody first walks onto it, so a player
        // waits a moment for the floor — and then stands on it. The valley
        // floor at Visp is 640 m and the ridge above it 1550; standing at 0 m
        // is standing where the world is not.
        await expect.poll(async () => (await where(page))?.height ?? 0,
            { timeout: UI, message: 'A should end up standing on the DEM' })
            .toBeGreaterThan(600);
        const at = await where(page);
        expect(at.height).toBeLessThan(1600);
        expect(metresBetween(at, CENTRE), 'A stands at the middle of the coverage')
            .toBeLessThan(400);
    });
    await test.step('the world is drawn, not an empty canvas', async () => {
        await expect.poll(async () => variety(await page.screenshot({ clip: VIEW })),
            { timeout: UI, message: 'the view should have ground in it' })
            .toBeGreaterThan(4);
    });
}

async function walkFiftyMetres(a) {
    const { page } = a;
    await test.step('A walks fifty metres and the ground follows', async () => {
        await shows(a, 'W A S D');
        const before = await where(page);
        const picture = await page.screenshot({ clip: VIEW });
        await page.locator('#view').click();
        await page.keyboard.down('w');
        await expect.poll(async () => {
            const now = await where(page);
            return now ? metresBetween(before, now) : 0;
        }, { timeout: UI, message: 'A should cover fifty metres' }).toBeGreaterThan(50);
        await page.keyboard.up('w');

        const after = await where(page);
        expect(after.height, 'the ground is still under A after the walk')
            .toBeGreaterThan(600);
        expect(differs(picture, await page.screenshot({ clip: VIEW })),
            'the view changed as A walked').toBeGreaterThan(0.02);
    });
}

test('story 1 — a first run puts the operator on their own ground',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);

        await test.step('the page opens on Setup, because nothing is set up', async () => {
            await expect(a.page.locator('#setup, [data-tab="Setup"]').first())
                .toBeVisible({ timeout: UI });
            await shows(a, 'Account');
        });

        await signUp(a, 'anna@visp.example', 'Anna');
        await chooseTheGround(a, world.geoserverUrl);
        await standingOnGround(a);
        await walkFiftyMetres(a);

        await a.close();
    });
