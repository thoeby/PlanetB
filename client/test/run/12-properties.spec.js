// Story 12 — an admin defines a property (docs/SPEC.md §3.10).
//
// A adds `leaf_type` to the kind "forest" with two choices, and makes it
// required. B, who downloaded a project before that, is told theirs is out of
// date; the next download has the dropdown, with exactly those two values in
// it; a wood drawn without the property is refused in words, and one drawn
// with a value that is not one of the two is refused naming them. Then the
// wood B does draw goes through the compile: submitted, approved, rendered,
// published.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, looking, open, panel, signIn, RENDER, UI }
    from './players.js';
import { drawInQgis, qgisPython } from './qgis.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const squareAt = ({ lon, lat }, size = 0.0004) =>
    `POLYGON((${lon - size} ${lat - size}, ${lon + size} ${lat - size},`
    + ` ${lon + size} ${lat + size}, ${lon - size} ${lat + size},`
    + ` ${lon - size} ${lat - size}))`;

async function definesIt(a) {
    await panel(a, 'Admin');
    await a.page.locator('.ad-kind').selectOption('forest');
    await a.page.locator('.ad-name').fill('leaf_type');
    await a.page.locator('.ad-type').selectOption('choice');
    await a.page.locator('.ad-choices').fill('broadleaved, needleleaved');
    await a.page.locator('.ad-required').check();
    await a.page.locator('.ad-save').click();
    await expect(a.page.locator('.ad-status'))
        .toContainText('vocabulary', { timeout: UI });
    // The list is the world's own answer, not the form's echo.
    const row = a.page.locator('.ad-prop', { hasText: 'leaf_type' });
    await expect(row).toContainText('broadleaved · needleleaved', { timeout: UI });
    await expect(row).toContainText('required');
}

async function standOnMyLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await b.page.locator('#standing .coords').textContent());
}

async function downloadsAgain(b) {
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-qgis-')),
        'splatworld.qgs');
    await file.saveAs(path);
    await expect(b.page.locator('.qgis-stale')).toHaveCount(0, { timeout: UI });
    return path;
}

function showsTheDropdown(project) {
    const [field] = drawInQgis(project,
        [{ ask: 'widget', layer: 'Wood', field: 'leaf_type' }]);
    expect(field.error ?? '', 'QGIS read the field').toBe('');
    expect(field.widget, 'the form offers a dropdown').toBe('ValueMap');
    expect(field.values.sort()).toEqual(['broadleaved', 'needleleaved']);
}

function drawsWithIt(project, here) {
    const [missing, wrong, drawn] = drawInQgis(project, [
        { layer: 'Wood', geometry: squareAt(here) },
        { layer: 'Wood', geometry: squareAt(here), attributes: { leaf_type: 'mixed' } },
        { layer: 'Wood', geometry: squareAt(here),
            attributes: { leaf_type: 'needleleaved' } },
    ]);
    expect(missing.ok, 'a wood with no leaf type is not saved').toBe(false);
    expect(missing.error).toContain('needs');
    expect(wrong.ok, 'a leaf type that is not one of the two is not saved')
        .toBe(false);
    expect(wrong.error).toContain('broadleaved, needleleaved');
    expect(drawn.error ?? '', 'the wood saved').toBe('');
    expect(drawn.ok).toBe(true);
}

async function compiles(b, c) {
    await panel(b, 'Submit');
    await expect(b.page.locator('.su-send')).toBeEnabled({ timeout: UI });
    await b.page.locator('.su-note').fill('a needleleaved wood');
    await b.page.locator('.su-send').click();
    await expect(b.page.locator('.su-status'))
        .toContainText('awaiting approval', { timeout: UI });
    await panel(b, 'Permission');
    await b.page.getByRole('button', { name: 'Approve' }).first().click();
    await expect(b.page.locator('.pm-status')).toContainText('queued', { timeout: UI });

    await looking(c);
    await panel(c, 'Render pool');
    const fine = c.page.locator('.rows li').filter({ hasText: 'assembled' });
    await expect(fine.first()).toBeVisible({ timeout: UI });
    await fine.first().getByRole('button', { name: 'Render' }).click();
    await expect(c.page.locator('.po-status'))
        .toContainText('is published', { timeout: RENDER });
}

test('story 12 — A defines a property, and the world is held to it',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here — install qgis and python3-qgis');
        const a = await open(browser, world, 'A', testInfo);
        const b = await open(browser, world, 'B', testInfo);
        const c = await open(browser, world, 'C', testInfo);
        await test.step('A signs in as the admin',
            () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        await test.step('A adds leaf_type to forest, with two choices',
            () => definesIt(a));

        const here = await test.step('B goes to their land', () => standOnMyLand(b));

        await test.step('B is told their QGIS project is out of date', async () => {
            await looking(b);
            await panel(b, 'Your land');
            await expect(b.page.locator('.qgis-stale'))
                .toContainText('out of date', { timeout: UI });
        });

        const project = await test.step('B downloads it again, and the notice goes',
            () => downloadsAgain(b));

        await test.step('QGIS shows the dropdown, with those two values in it',
            () => showsTheDropdown(project));

        await test.step('B draws with it, and what is not one of the two is refused',
            () => drawsWithIt(project, here));

        await test.step('the page says a tile changed', async () => {
            await looking(b);
            await panel(b, 'Your land');
            await expect(b.page.locator('.land-drawn'))
                .toContainText('forest', { timeout: UI });
            await expect(b.page.locator('.land-changed'))
                .toContainText(/\d+ tiles? changed/, { timeout: UI });
        });

        // "The compile uses it": the wood B drew with the new property is what
        // the tile is compiled from, and the tile publishes.
        await test.step('and the compile takes it as far as a published tile',
            () => compiles(b, c));

        await a.close();
        await b.close();
        await c.close();
    });
