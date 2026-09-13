// Story 3 — shaping land in QGIS (docs/SPEC.md §3.3).
//
// B downloads the project from the Land panel, opens it in QGIS, draws a wood
// with a leaf type and puts a tree down with a model named on it, and saves.
// The page says a tile changed, without being reloaded. Drawing off B's land
// is refused, in a sentence QGIS shows.
//
// The connection is a direct one: QGIS is the player, under the same
// row-level security as the browser (REFACTOR-direct-pg.md). A pass over
// WFS-T would not be this story.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, open, shows, panel, signIn, UI } from './players.js';
import { drawInQgis, qgisPython } from './qgis.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// A small square around a point, as QGIS would have drawn it.
const squareAt = ({ lon, lat }, size = 0.0006) =>
    `POLYGON((${lon - size} ${lat - size}, ${lon + size} ${lat - size},`
    + ` ${lon + size} ${lat + size}, ${lon - size} ${lat + size},`
    + ` ${lon - size} ${lat - size}))`;


// B stands on their own land and reads where they are: the script never types
// the land's position, it goes there and looks.
async function standOnMyLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field',
        { timeout: UI });
    return readCoords(await b.page.locator('#standing .coords').textContent());
}

async function downloadProject(b) {
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-qgis-')),
        'splatworld.qgs');
    await file.saveAs(path);
    return path;
}

test('story 3 — B shapes their land in QGIS, and the page says so',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here — install qgis and python3-qgis');
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        const here = await test.step('B goes to their land', () => standOnMyLand(b));
        const project = await test.step('and downloads the project for it',
            () => downloadProject(b));

        await test.step('QGIS opens it and B draws a wood and a tree', async () => {
            const [wood, tree] = drawInQgis(project, [
                { layer: 'Wood', geometry: squareAt(here),
                    attributes: { leaf_type: 'broadleaved' } },
                { layer: 'Single tree', geometry: `POINT(${here.lon} ${here.lat})`,
                    attributes: { model: 'Larch' } },
            ]);
            expect(wood.error ?? '', 'the wood saved').toBe('');
            expect(wood.ok).toBe(true);
            expect(tree.error ?? '', 'the tree saved').toBe('');
            expect(tree.ok).toBe(true);
        });

        await test.step('the page says a tile changed, without being reloaded',
            async () => {
                await panel(b, 'Your land');
                await expect(b.page.locator('.land-changed'))
                    .toContainText(/\d+ tiles? changed/, { timeout: UI });
            });

        await test.step('and what was drawn is listed on the land', async () => {
            await shows(b, 'forest');
            await shows(b, 'tree');
        });

        await test.step('drawing off B’s land is refused, in words', async () => {
            const [out] = drawInQgis(project, [{
                layer: 'Wood',
                geometry: squareAt({ lon: here.lon + 0.02, lat: here.lat + 0.01 }),
            }]);
            expect(out.ok, 'QGIS should not have saved that').toBe(false);
            expect(out.error).toContain('that is not your land');
        });

        await b.close();
    });
