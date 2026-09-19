// Story 28 — the ground goes with the land (FND.13).
//
// The cover is the operator's: a raster over the whole world, mapped onto the
// world's own words (story 27). Land that belongs to somebody is different.
// When A assigns it, what the cover says is there is traced onto it as B's own
// shapes — in Landuse and Natural, in QGIS, editable like anything he drew
// himself. He cuts a clearing out of the wood, sends it, and the ground that
// comes out of the compiler has a clearing in it: in the world, on the map,
// and in the project's "Rendered ground" the next time he opens it.
//
// Off his land nothing moved. The operator's raster is still what is there.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { differs, variety } from './pixels.js';
import { drawInQgis, qgisPython } from './qgis.js';

const VIEW = { x: 690, y: 120, width: 370, height: 240 };

test.setTimeout(2_400_000);

const status = (p) => p.page.locator('.po-status');

// 1 — a second land for B, across the edge of a wood, and the cover on it.
async function assigns(a, ring) {
    await panel(a, 'Land');
    const waiting = a.page.locator('.assign-requests li').first();
    await expect(waiting).toBeVisible({ timeout: UI });
    await waiting.click();
    await a.page.locator('#assign-boundary').fill(ring);
    await a.page.locator('#assign-name').fill('Ben’s wood');
    await a.page.getByRole('button', { name: 'Assign this land' }).click();
    // The tracing is this tab's work and it says so while it runs.
    await expect(a.page.locator('.assign-status'))
        .toContainText('Cover copied:', { timeout: 300_000 });
    const said = await a.page.locator('.assign-status').textContent();
    expect(Number(/Cover copied: (\d+)/.exec(said)?.[1] ?? 0),
        'the wood inside the land became shapes').toBeGreaterThan(0);
}

async function downloadProject(b) {
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).first().click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-cover-')), 'splatworld.qgs');
    await file.saveAs(path);
    return path;
}

// 3 — the clearing: B deletes the shapes in the middle of his wood.
function cutsAClearing(project, at) {
    const [out] = drawInQgis(project, [{ ask: 'delete', layer: 'Landuse',
        within: `POINT(${at.lon} ${at.lat})`, metres: 40 }]);
    expect(out.error ?? '', 'QGIS took the clearing out').toBe('');
    expect(out.deleted, 'and there was something there to take out')
        .toBeGreaterThan(0);
}

async function sendsIt(b) {
    await panel(b, 'Submit');
    await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
    await b.page.locator('.su-note').fill('a clearing in the wood');
    await b.page.locator('.su-mine').click();
    await expect(b.page.locator('.su-status'))
        .toContainText('render job(s) in the pool', { timeout: UI });
}

async function emptyThePool(c, most = 3) {
    await panel(c, 'Work');
    for (let i = 0; i < most; i++) {
        await c.page.evaluate(() => window.splatworld.pool.refresh());
        const row = c.page.locator('.po-list li').filter({ hasText: 'Render' }).first();
        if (!await row.count()) return i;
        await row.getByRole('button', { name: 'Render' }).click();
        await expect(status(c)).toContainText(
            /assembling|framing|training|merging|encoding/, { timeout: UI });
        await expect(status(c)).toContainText('is published', { timeout: RENDER });
    }
    return most;
}

async function pictureAt(p, world, here) {
    await p.page.goto(`${world.pageUrl}#at=${here.lat},${here.lon},0,0`);
    await p.page.waitForFunction(() => Boolean(window.splatworld?.app), null,
        { timeout: 120_000 });
    await panel(p, 'Setup');
    await expect(p.page.locator('#world'))
        .toContainText(/[1-9]\d* loaded/, { timeout: RENDER });
    const shot = await p.page.screenshot({ clip: VIEW });
    expect(variety(shot), 'there is a world to look at').toBeGreaterThan(20);
    return shot;
}

// 5 — ground nobody owns is still the operator's raster, drawn as it was.
async function stillThere(browser, world, testInfo) {
    const d = await open(browser, world, 'A', testInfo);
    await signIn(d, 'anna@visp.example', 'Anna');
    const shot = await pictureAt(d, world, { lon: 7.8700, lat: 46.2800 });
    expect(variety(shot), 'the operator’s own ground is as it was').toBeGreaterThan(20);
    await d.close();
}

test('story 28 — the cover becomes the land’s own, and a clearing shows',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here');

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('and asks for a second piece of land', async () => {
            await panel(b, 'Your land');
            await b.page.getByRole('button', { name: 'Request land' }).click();
            await expect(b.page.locator('#land-status'))
                .toContainText(/asked|waiting/i, { timeout: UI });
        });

        // A piece of the hillside north of his field, where the cover has a
        // wood in it (story 27 mapped swissTLM3D's Wald).
        const ring = '7.8790,46.2985 7.8830,46.2985 7.8830,46.3010 7.8790,46.3010';
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in as the operator',
            () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('1 — A assigns it, and the cover goes with it',
            () => assigns(a, ring));
        await a.close();

        const here = { lon: 7.881, lat: 46.2997 };
        const before = await test.step('what the ground looks like now',
            () => pictureAt(b, world, here));

        const project = await test.step('2 — B downloads, and the wood is his',
            async () => {
                await panel(b, 'Your land');
                const path = await downloadProject(b);
                const [found] = drawInQgis(path, [{ ask: 'widget',
                    layer: 'Landuse', field: 'landuse' }]);
                expect(found.ok, 'Landuse is in the project, with its dropdown')
                    .toBe(true);
                return path;
            });

        await test.step('3 — B cuts a clearing out of it', async () => {
            cutsAClearing(project, here);
            await sendsIt(b);
        });
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C renders it', () => emptyThePool(c));
        const after = await test.step('4 — and the clearing is in the ground',
            () => pictureAt(c, world, here));
        expect(differs(before, after), 'the ground changed where the clearing is')
            .toBeGreaterThan(0.001);

        await test.step('and the map shows it too', async () => {
            // The map draws the published tile's own cover picture
            // (client/js/covermap.js), which is the same ground.
            await expect.poll(async () => c.page.evaluate(
                () => Boolean(document.querySelector('#minimap')?.width)),
            { timeout: UI }).toBe(true);
        });
        await c.close();

        await test.step('5 — and off his land nothing moved',
            () => stillThere(browser, world, testInfo));
    });
