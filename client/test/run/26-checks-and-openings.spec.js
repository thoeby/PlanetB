// Story 26 — what cannot be built, what takes the ground away, and the shapes
// that are on their way out (FND.11).
//
// 1. B's road runs across a hillside he has not shaped. Submit says so, with a
//    way to go and look at each place. It is a warning: the submission goes.
// 2. B puts the tunnel portal of story 21 against the slope. Where its mouth
//    is, the compiler builds no ground at all, and the picture shows it.
// 3. The world still has a `terrainmod` — the only way to move the ground
//    before FND.9. A converts them into the grid that moves it now; nothing
//    anybody sees changes (client/test/terrainmod.test.js proves that to the
//    centimetre), and QGIS stops offering the kind.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { differs, variety } from './pixels.js';
import { drawInQgis, qgisPython } from './qgis.js';

test.setTimeout(1_500_000);

const VIEW = { x: 690, y: 120, width: 370, height: 240 };

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const squareAt = ({ lon, lat }, size = 0.0002) =>
    `POLYGON((${lon - size} ${lat - size}, ${lon + size} ${lat - size},`
    + ` ${lon + size} ${lat + size}, ${lon - size} ${lat + size},`
    + ` ${lon - size} ${lat - size}))`;

async function goesToHisLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await b.page.locator('#standing .coords').textContent());
}

async function downloadProject(b) {
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-old-')), 'splatworld.qgs');
    await file.saveAs(path);
    return path;
}

// 1 — the road across the slope, said before anybody else is shown it.
async function theSteepRoad(b) {
    await panel(b, 'Submit');
    const flags = b.page.locator('.su-flags');
    await expect(flags).toContainText('Road too steep across at', { timeout: UI });
    await expect(flags).toContainText('it can be sent anyway');
    // Every place has a way to go and look at it.
    await expect(flags.locator('.su-go').first()).toBeVisible();
    await flags.locator('.su-go').first().click();
    await expect(b.page.locator('#standing .coords')).not.toHaveText('', { timeout: UI });
}

// 2 — the portal, and the hole its mouth makes.
async function placesThePortal(b) {
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.build-search');
    await search.fill('Tunnelportal');
    await search.dispatchEvent('change');
    const row = b.page.locator('.build-asset', { hasText: 'Tunnelportal' }).first();
    await expect(row).toBeVisible({ timeout: UI });
    await row.locator('button').click();
    await b.page.mouse.click(860, 540);
    await expect(b.page.locator('.build-sel')).toContainText(/placing|selected|Move/i,
        { timeout: UI });
    await b.page.locator('.build-save').click();
    await expect(b.page.locator('.build-saved')).toContainText(/saved|nothing/i,
        { timeout: UI });
    await b.page.locator('.build-toggle').uncheck();
}

async function sendsIt(b) {
    await panel(b, 'Submit');
    await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
    await b.page.locator('.su-note').fill('the portal against the slope');
    await b.page.locator('.su-mine').click();
    await expect(b.page.locator('.su-status'))
        .toContainText('render job(s) in the pool', { timeout: UI });
}

const status = (p) => p.page.locator('.po-status');

async function emptyThePool(c, most = 4) {
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
        { timeout: 120000 });
    await panel(p, 'Setup');
    await expect(p.page.locator('#world'))
        .toContainText(/[1-9]\d* loaded/, { timeout: RENDER });
    const shot = await p.page.screenshot({ clip: VIEW });
    expect(variety(shot), 'there is a world to look at').toBeGreaterThan(20);
    return shot;
}

// 3 — a shape of the old kind, and the operator turning every one of them into
// the grid that moves the ground now.
function drawsAnOldShape(project, here) {
    const [out] = drawInQgis(project, [{
        layer: 'Terrain edit', geometry: squareAt(here),
        attributes: { op: 'flatten', amount: 0 },
    }]);
    expect(out.error ?? '', 'the old shape saved').toBe('');
    expect(out.ok).toBe(true);
}

async function aConverts(a) {
    await panel(a, 'Setup');
    const said = a.page.locator('.gs-old-said');
    await expect(said).toContainText('Old terrain edits: 1 on 1 land',
        { timeout: UI });
    await a.page.locator('.gs-old-go').click();
    await expect(said).toContainText('converted 1 shape(s)', { timeout: UI });
    await expect(a.page.locator('.gs-old')).toBeHidden({ timeout: UI });
}

test('story 26 — a road that is too steep, a mouth in the ground, and the old'
    + ' shapes retired', async ({ browser, world }, testInfo) => {
    test.skip(!qgisPython(), 'no PyQGIS here');
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    const here = await test.step('B goes to his land', () => goesToHisLand(b));
    expect(here).not.toBeNull();

    const before = await b.page.screenshot({ clip: VIEW });

    await test.step('1 — the road across the slope is flagged, not refused',
        () => theSteepRoad(b));

    // Go took him to one of the steep places; the portal goes where he was.
    await test.step('2 — B puts the portal against the slope', async () => {
        await goesToHisLand(b);
        await placesThePortal(b);
    });

    const project = await test.step('and draws a shape of the old kind', async () => {
        await panel(b, 'Your land');
        const path = await downloadProject(b);
        drawsAnOldShape(path, here);
        return path;
    });

    await test.step('B sends it all', () => sendsIt(b));
    await b.close();

    const c = await open(browser, world, 'C', testInfo);
    await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
    await test.step('C renders it', () => emptyThePool(c));
    const after = await test.step('and the ground has a mouth in it',
        () => pictureAt(c, world, here));
    expect(differs(before, after), 'the ground changed where the portal is')
        .toBeGreaterThan(0.001);
    await c.close();

    const a = await open(browser, world, 'A', testInfo);
    await test.step('A signs back in as the operator',
        () => signIn(a, 'anna@visp.example', 'Anna'));
    await test.step('3 — A converts the old shapes', () => aConverts(a));
    await a.close();

    // The project on B's disk still has the layer — it is the one the shape
    // was drawn in. The next one he takes does not.
    const b2 = await open(browser, world, 'B', testInfo);
    await test.step('B signs in again', () => signIn(b2, 'ben@visp.example', 'Ben'));
    await test.step('and QGIS no longer offers the kind', async () => {
        await goesToHisLand(b2);
        const fresh = await downloadProject(b2);
        const asked = { ask: 'widget', layer: 'Terrain edit', field: 'op' };
        expect(drawInQgis(project, [asked])[0].ok, 'it was there').toBe(true);
        expect(drawInQgis(fresh, [asked])[0].ok, 'and is not any more').toBe(false);
    });
    await b2.close();
});
