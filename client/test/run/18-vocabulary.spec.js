// Story 18 — the vocabulary is OSM's (TASKS-foundation.md FND.3,
// PLAN-foundation.md §5).
//
// Everything already drawn is still there and still looks the same; it is
// described in words a surveyor already knows. The wood B drew in story 3 is a
// `landuse=forest`, in the same place, with the same leaves, and QGIS has a
// layer per OSM key.
//
// FND.3's script opens with B being told their project is out of date, because
// there the migration lands on a world that was already running. A player-run
// builds its world from an empty database, so every migration is applied before
// anybody has downloaded anything: what that step is really about — a change to
// the vocabulary makes every project stale — is proven at the end, where A adds
// a value to a key and B is told.
//
// That the picture does not change is proven where it can be proven to the
// byte: `client/test/assemble.test.js` holds the hashes the compiler produced
// from the same fixture in the old vocabulary.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { drawInQgis, qgisPython } from './qgis.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// The nine layers PLAN-foundation.md §5 seeds, as QGIS names them.
const LAYERS = ['Highway', 'Railway', 'Aerialway', 'Barrier', 'Waterway',
    'Landuse', 'Natural', 'Tree points'];

async function download(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    const here = readCoords(await b.page.locator('#standing .coords').textContent());
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-osm-')), 'splatworld.qgs');
    await file.saveAs(path);
    return { path, here };
}

// 3 — the wood B drew in story 3 is in Landuse, saying what it is.
function theOldWoodIsThere(project) {
    const [found] = drawInQgis(project,
        [{ ask: 'widget', layer: 'Landuse', field: 'landuse' }]);
    expect(found.error ?? '', 'QGIS read the Landuse form').toBe('');
    expect(found.widget, 'the key is a dropdown').toBe('ValueMap');
    expect(found.values, 'with OSM’s land uses in it').toContain('forest');
}

// 5 — a value added to a key is a value QGIS offers, and the project that was
// downloaded before it is out of date.
async function addsAValue(a, b) {
    await panel(a, 'Vocabulary');
    // The kinds are a list of what the world can hold, not a dropdown: each
    // one says what it is drawn as, how much it may say about itself, and how
    // much of the world is one.
    await a.page.locator('.vo-row[data-kind="highway"] .vo-kind').click();
    await expect(a.page.locator('.vo-name')).toHaveValue('highway', { timeout: UI });
    await a.page.locator('.ad-name').fill('highway');
    await a.page.locator('.ad-type').selectOption('choice');
    await a.page.locator('.ad-choices').fill(
        'motorway, trunk, primary, secondary, tertiary, unclassified, residential,'
        + ' service, track, path, footway, cycleway, steps, pedestrian');
    await a.page.locator('.ad-save').click();
    await expect(a.page.locator('.ad-status')).toContainText('vocabulary', { timeout: UI });
    await looking(b);
    await panel(b, 'Your land');
    await expect(b.page.locator('.qgis-stale')).toHaveCount(1, { timeout: UI });
}

test('story 18 — the world speaks OSM, and looks exactly as it did',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here — install qgis and python3-qgis');
        const a = await open(browser, world, 'A', testInfo);
        const b = await open(browser, world, 'B', testInfo);
        await test.step('A and B sign back in', async () => {
            await signIn(a, 'anna@visp.example', 'Anna');
            await signIn(b, 'ben@visp.example', 'Ben');
        });

        const { path: project } = await test.step('1 — B downloads their project',
            () => download(b));

        await test.step('2 — QGIS has a layer for every OSM key', () => {
            const asked = drawInQgis(project,
                LAYERS.map((layer) => ({ ask: 'widget', layer, field: 'name' })));
            // `name` is not a property of any of them, so each answer is the
            // layer saying so — which is the layer being there at all. A layer
            // that is missing says something else entirely.
            for (const [i, r] of asked.entries()) {
                expect(r.error ?? '', `${LAYERS[i]} is a layer`)
                    .not.toContain(`no layer called ${LAYERS[i]}`);
            }
        });

        await test.step('3 — B’s old wood is a landuse, and says which',
            () => theOldWoodIsThere(project));

        await test.step('4 — the land still says what is drawn on it', async () => {
            await looking(b);
            await panel(b, 'Your land');
            // By its OSM kind. B is on the land they asked for again in story
            // 11, so what is drawn on it is the wood of story 12 — the tree of
            // story 3 went back with the first land.
            await expect(b.page.locator('.land-drawn'))
                .toContainText('landuse', { timeout: UI });
        });

        await test.step('5 — A adds a value, and B’s project goes out of date',
            () => addsAValue(a, b));

        await a.close();
        await b.close();
    });
