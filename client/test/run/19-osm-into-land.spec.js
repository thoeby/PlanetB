// Story 19 — an OSM extract, into a land, through QGIS (FND.4).
//
// B has a file of real OSM shapes and a land of his own. He opens both in
// QGIS, selects what is inside his boundary, and pastes it into the layers the
// project gave him: Highway, Building, Landuse, Natural, Barrier, Tree points.
// The mapping is the obvious one — an OSM key is a property of the same name,
// which is the whole point of FND.3.
//
// Three things have to be true of it: a feature that runs off the end of his
// land is refused until he clips it, a value the vocabulary does not have is
// refused naming the ones it does, and the page counts what arrived.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { importFromFile, qgisPython } from './qgis.js';

const OSM = 'infra/seed/osm-visp.gpkg';

// The boundary of the land B is standing on, as the page has drawn it for
// them: a rectangle round it is what a QGIS user selects with.
async function myLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    const box = await b.page.evaluate(() => {
        const mine = (window.splatworld.land.areas() ?? []).filter((a) => a.mine);
        return mine.length ? mine[0].bbox : null;
    });
    expect(box, 'B is standing on land of their own').not.toBeNull();
    return box;
}

const wkt = (b) => `POLYGON((${b.west} ${b.south}, ${b.east} ${b.south},`
    + ` ${b.east} ${b.north}, ${b.west} ${b.north}, ${b.west} ${b.south}))`;

async function project(b) {
    const waiting = b.page.waitForEvent('download', { timeout: UI });
    await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
    const file = await waiting;
    const path = join(mkdtempSync(join(tmpdir(), 'splatworld-osm-')), 'splatworld.qgs');
    await file.saveAs(path);
    return path;
}

// Everything whose middle is on my land: what QGIS selects when a surveyor
// drags a box round their own boundary and takes what is inside it.
const inside = (land, more = '') =>
    `intersects(point_on_surface($geometry), geom_from_wkt('${wkt(land)}'))${more}`;

// The six pastes, each the OSM key mapped to the property of the same name.
const PASTES = [
    { layer: 'Highway', source: 'lines',
        where: "highway IS NOT NULL AND highway <> 'bridleway'",
        into: { highway: 'highway', surface: 'surface', lanes: 'lanes',
            width: 'width', lit: 'lit' } },
    { layer: 'Building', source: 'areas', where: 'building IS NOT NULL',
        into: { building: 'building', height: 'height',
            'building:levels': 'building:levels', 'roof:shape': 'roof:shape' } },
    { layer: 'Landuse', source: 'areas', where: 'landuse IS NOT NULL',
        into: { landuse: 'landuse', leaf_type: 'leaf_type',
            leaf_cycle: 'leaf_cycle' } },
    { layer: 'Natural', source: 'areas', where: 'natural IS NOT NULL',
        into: { natural: 'natural' } },
    { layer: 'Barrier', source: 'lines', where: 'barrier IS NOT NULL',
        into: { barrier: 'barrier', height: 'height', material: 'material' } },
    { layer: 'Tree points', source: 'points', where: 'natural IS NOT NULL',
        into: { natural: 'natural', genus: 'genus', species: 'species',
            height: 'height', leaf_type: 'leaf_type' } },
];

function pastesWhatIsInside(proj, land) {
    const got = {};
    for (const p of PASTES) {
        const out = importFromFile(proj, p.layer, OSM, p.source,
            `(${p.where}) AND ${inside(land)}`, p.into, wkt(land));
        // A layer with nothing of its own inside this land is not a failure of
        // the import; it is a land with no walls on it.
        if (out.error === 'nothing is selected') { got[p.layer] = 0; continue; }
        expect(out.error ?? '', `${p.layer} took what was pasted into it`).toBe('');
        got[p.layer] = out.pasted;
    }
    expect(Object.values(got).reduce((a, n) => a + n, 0),
        'something arrived').toBeGreaterThan(0);
    return got;
}

// 2 — what is not on my land is not mine to draw, and a clip is what makes a
// road that runs off the end of it mine as far as the boundary.
function offTheEnd(proj, land) {
    const off = `disjoint($geometry, geom_from_wkt('${wkt(land)}'))`;
    const elsewhere = importFromFile(proj, 'Highway', OSM, 'lines',
        `highway IS NOT NULL AND ${off}`, { highway: 'highway' });
    expect(elsewhere.error ?? '', 'the extract reaches beyond this land')
        .not.toBe('nothing is selected');
    expect(elsewhere.ok, 'a road that is nowhere near my land is refused')
        .toBe(false);
    expect(elsewhere.error, 'in the words the world uses for it')
        .toMatch(/that is not your land|lies outside area/);

    // The road that does cross it, cut at the boundary. What lands is inside
    // the land, which is the whole of what the clip is for.
    const crosses = `highway IS NOT NULL AND NOT ${off}`
        + ` AND NOT within($geometry, geom_from_wkt('${wkt(land)}'))`;
    const clipped = importFromFile(proj, 'Highway', OSM, 'lines', crosses,
        { highway: 'highway' }, wkt(land));
    expect(clipped.error ?? '', 'a road clipped to the land is taken').toBe('');
    expect(clipped.pasted).toBeGreaterThan(0);
    const [west, south, east, north] = clipped.extent;
    const slack = 1e-9;
    expect(west, 'and nothing of it is west of the boundary')
        .toBeGreaterThanOrEqual(land.west - slack);
    expect(east).toBeLessThanOrEqual(land.east + slack);
    expect(south).toBeGreaterThanOrEqual(land.south - slack);
    expect(north).toBeLessThanOrEqual(land.north + slack);
}

// 4 — a value the vocabulary does not have.
function aValueNobodyAllowed(proj, land) {
    const where = `highway = 'bridleway' AND ${inside(land)}`;
    const refused = importFromFile(proj, 'Highway', OSM, 'lines', where,
        { highway: 'highway' }, wkt(land));
    expect(refused.error ?? '', 'the extract has the bridleway this is about')
        .not.toBe('nothing is selected');
    expect(refused.ok, 'a highway value nobody allowed is not saved').toBe(false);
    expect(refused.error, 'and the refusal names the ones that are')
        .toContain('must be one of');
    expect(refused.error).toContain('path');

    // Mapped to one the vocabulary has, it goes in. `path` is a value, not a
    // field of the source, so the import writes it as one.
    const mapped = importFromFile(proj, 'Highway', OSM, 'lines', where,
        { highway: 'path' }, wkt(land));
    expect(mapped.error ?? '', 'mapped to a path, it is taken').toBe('');
}

test('story 19 — an OSM extract goes onto a land through QGIS',
    async ({ browser, world }, testInfo) => {
        test.skip(!qgisPython(), 'no PyQGIS here — install qgis and python3-qgis');
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));

        const land = await test.step('and stands on their land', () => myLand(b));
        const proj = await test.step('with the project open in QGIS', () => project(b));

        const counts = await test.step('1 — what is inside the land is pasted in',
            () => pastesWhatIsInside(proj, land));
        await test.step('2 — what runs off the end is clipped first',
            () => offTheEnd(proj, land));
        await test.step('4 — a value the vocabulary has not got is refused',
            () => aValueNobodyAllowed(proj, land));

        await test.step('3 — the page counts it, by kind', async () => {
            await looking(b);
            await panel(b, 'Your land');
            await expect(b.page.locator('.land-changed'))
                .toContainText(/\d+ tiles? changed/, { timeout: UI });
            await panel(b, 'Submit');
            const said = b.page.locator('.su-changes');
            await expect(said).toContainText('drawn', { timeout: UI });
            // The counts per kind, which is what somebody who has just pasted
            // into six layers wants to see (db/0158).
            for (const [layer, n] of Object.entries(counts)) {
                if (!n) continue;
                const kind = { Highway: 'highway', Building: 'building',
                    Landuse: 'landuse', Natural: 'natural', Barrier: 'barrier',
                    'Tree points': 'natural_point' }[layer];
                await expect(said, `${kind} is counted`).toContainText(kind);
            }
        });

        await b.close();
    });
