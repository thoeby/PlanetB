// Story 25 — the shaped ground is a layer in the project (FND.10).
//
// B shaped his ground in the page in story 24. It is not the page's ground: it
// is the world's, and the project the page hands him has it as a raster like
// any other — "Ground shaping (m)", read from the world's own file. A
// raster-editing plugin adds three metres to a block of it, the script that
// ships with the project sends it back, and within half a minute the page says
// so. Off his own land the world refuses it in words.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, open, panel, signIn, PASSWORD, UI } from './players.js';
import { qgisPython, shapeInQgis } from './qgis.js';

test.setTimeout(900_000);

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// The project, downloaded the way the Land panel hands it over.
async function download(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    const here = readCoords(await b.page.locator('#standing .coords').textContent());
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-shape-')), 'splatworld.qgs');
    await file.saveAs(path);
    return { path, here };
}

// Which land this is, read off the page the way a person reads it: the Shape
// panel names it, and the world answers with its id.
async function landOf(b) {
    await panel(b, 'Shape');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    return b.page.locator('.sc-land').inputValue();
}

test('story 25 — B shapes his ground in QGIS, and the world has it',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here');
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));

        const { path } = await test.step('B downloads the project', () => download(b));
        const area = await landOf(b);
        const login = { world: world.pageUrl.split('/app/')[0],
            email: 'ben@visp.example', password: PASSWORD };

        // 1 and 2 — the layer is there with story 24's shaping in it, and a
        // plugin adds three metres to a block inside the land.
        const said = await test.step('QGIS has the layer, and raises a block of it',
            () => shapeInQgis(path, { ...login, area, add: 3, block: 'middle' }));
        expect(said.error ?? '', 'QGIS opened the shaped ground').toBe('');
        expect(said.width, 'and it is the land’s own grid').toBeGreaterThan(100);
        // Story 24 left this land shaped; the block is three metres above that.
        expect(said.highest, 'three metres above what was already there')
            .toBeGreaterThan(3);
        expect(said.ok, 'and the world took it').toBe(true);
        expect(Number(said.rev), 'as the next revision').toBeGreaterThan(1);

        // 3 — the page says so, without being reloaded.
        await test.step('the page says the ground moved', async () => {
            await panel(b, 'Submit');
            await expect(b.page.locator('.su-changes'))
                .toContainText('ground shaped', { timeout: 60_000 });
        });

        // 4 — and the same raster sent to a land that is not his is refused by
        // the world, in words. The layer is his; the land it is sent to is
        // not, which is the only thing this is about.
        await test.step('another land is refused, in words', () => {
            const no = shapeInQgis(path, { ...login, area,
                save_as: '11111111-2222-3333-4444-555555555555',
                add: 3, block: 'middle' });
            expect(no.ok, 'the world refused it').toBe(false);
            expect(no.error, 'and said why')
                .toContain('you can only shape your own land');
        });

        await b.close();
    });
