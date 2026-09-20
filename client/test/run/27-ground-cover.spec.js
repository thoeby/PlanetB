// Story 27 — the ground between the drawn things (FND.12).
//
// Until now the ground was a ramp: green low down, grey where it is steep,
// white high up. The world it stands on knows better than that, and the
// operator has it — swissTLM3D says where the wood, the rock and the glacier
// are, ESA WorldCover says the rest. Neither of them speaks this world's
// vocabulary, so A maps them: this colour is `landuse=forest`.
//
// What a `landuse=forest` then looks like is not in the mapping and not in the
// raster. It is the symbol's `paint` layer, the same one a drawn forest uses,
// and it reaches the world the one way a symbol ever does — when somebody
// applies it. A class nobody mapped is listed, is not shown, and breaks
// nothing.

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { differs, variety } from './pixels.js';

const VIEW = { x: 690, y: 120, width: 370, height: 240 };

// The cover is every published tile: applying it asks for more rendering than
// any other story does, and this takes only as much of it as it looks at.
test.setTimeout(2_400_000);

// The classes the two fixtures carry, by the colour their style paints them
// (tools/geoserver_cover.py). A class's colour is computed from its code, so
// these are what the panel reads out of the ground and what the mapping is
// written against.
const TLM = { Wald: '#06dfeb', Fels: '#0172f8', Gletscher: '#030426' };
const WORLDCOVER = { trees: '#0a0347', grassland: '#1eb713' };

const status = (p) => p.page.locator('.po-status');
const said = (a) => a.page.locator('.cv-said');

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// 1 — the two sources, added the way an operator adds one: connect, pick,
// priority, add.
async function addsSources(a, world) {
    await panel(a, 'Ground cover');
    for (const [layer, priority] of [['splatworld:tlm', '0'],
        ['splatworld:worldcover', '1']]) {
        // Step 1 is behind its own button: the address, the password and the
        // layer are what you do once, and they were half the panel for ever.
        await a.page.locator('.cv-new').click();
        await expect(a.page.locator('.cv-url')).toBeVisible({ timeout: UI });
        await a.page.locator('.cv-url').fill(world.geoserverUrl);
        await a.page.locator('.cv-connect').click();
        await expect(a.page.locator('.cv-status'))
            .toContainText('layer(s)', { timeout: UI });
        await a.page.locator('.cv-layer').selectOption(layer);
        await a.page.locator('.cv-priority').fill(priority);
        await a.page.locator('.cv-add').click();
        await expect(a.page.locator('.cv-sources')).toContainText(layer, { timeout: UI });
    }
}

// The row of one class, found by the colour its style paints it.
const rowOf = (a, colour) => a.page.locator('.cv-map tr', { hasText: colour }).first();

async function maps(a, colour, kind, key, value) {
    const row = rowOf(a, colour);
    await expect(row).toBeVisible({ timeout: UI });
    await row.locator('.cv-kind').selectOption(kind);
    await row.locator('.cv-key').fill(key);
    await row.locator('.cv-key').dispatchEvent('change');
    await row.locator('.cv-value').fill(value);
    await row.locator('.cv-value').dispatchEvent('change');
}

// 2 — what each class is, in the world's own words. The classes are read out
// of the ground the world cut, not typed from a data sheet.
async function mapsThem(a, layer, rows) {
    // One control for one choice: the source is picked in the list on the
    // left, which drives everything on the right.
    await a.page.locator('.cv-source-pick', { hasText: layer }).first().click();
    await expect(a.page.locator('.cv-which')).toHaveText(layer, { timeout: UI });
    await a.page.locator('.cv-read').click();
    await expect(said(a)).toContainText('class(es) in it', { timeout: 120_000 });
    for (const [colour, kind, key, value] of rows) await maps(a, colour, kind, key, value);
    await a.page.locator('.cv-save').click();
    await expect(said(a)).toContainText('not in the world yet', { timeout: UI });
}

// 4 — a class nobody said anything about. It is in the table, it says it is
// not shown, and nothing anywhere refuses anything.
async function theUnmapped(a) {
    // The table says which rows are not said, and counts them in its own head:
    // "not shown" is the unchosen option of every row's select, so the class
    // is the thing to look at, not the words.
    const unmapped = a.page.locator('.cv-map tr.cv-unmapped');
    await expect(unmapped.first()).toBeVisible({ timeout: UI });
    expect(await unmapped.count(), 'the classes A did not map are still listed')
        .toBeGreaterThan(0);
    await expect(a.page.locator('.cv-counted')).toContainText('said', { timeout: UI });
    await expect(a.page.locator('.cv-said')).not.toHaveAttribute('data-bad', '1');
}

// A symbol for one class of the ground: what it is made of, and — for the
// wood — what is scattered over it.
async function paints(a, name, kind, key, value, material, collection = null) {
    await panel(a, 'Symbols');
    await a.page.locator('.sy-new').click();
    await a.page.locator('.sy-name').fill(name);
    await a.page.locator('.sy-kind').selectOption(kind);
    await a.page.locator('.sy-add-cond').click();
    const cond = a.page.locator('.sy-conds .sy-cond').first();
    await cond.locator('.prop').fill(key);
    await cond.locator('.val').fill(`"${value}"`);
    await cond.locator('.val').dispatchEvent('change');

    await a.page.locator('.sy-add-layer').selectOption('paint');
    await a.page.locator('.sy-layer-form .sy-f-material').fill(material);
    await a.page.locator('.sy-layer-form .sy-f-blend').fill('12');
    await a.page.locator('.sy-layer-form .sy-f-tiling').fill('4');
    if (collection) {
        await a.page.locator('.sy-add-layer').selectOption('scatter');
        await a.page.locator('.sy-layer-form .sy-f-collection').fill(collection);
        await a.page.locator('.sy-layer-form .sy-f-spacing').fill('9');
    }
    await a.page.locator('.sy-save').click();
    await expect(a.page.locator('.sy-status'))
        .toContainText('not in the world yet', { timeout: UI });
}

// The catalogue number of a product, found the way a person finds it.
async function sanOf(a, name) {
    await panel(a, 'Catalog');
    await a.page.locator('#type').selectOption('');
    await a.page.locator('#q').fill(name);
    await a.page.getByRole('button', { name: 'Find' }).click();
    const card = a.page.locator('#results li', { hasText: name }).first();
    await expect(card).toBeVisible({ timeout: UI });
    return (await card.locator('.san').textContent()).trim();
}

// 3 — applied. The header counts the cover apart from the symbols, because it
// is not one.
async function applies(a) {
    await panel(a, 'Symbols');
    const changed = a.page.locator('.sy-changed');
    await expect(changed).toContainText('the ground cover', { timeout: UI });
    await expect(changed).toContainText('would be rebuilt');
    await a.page.locator('.sy-apply').click();
    await expect(a.page.locator('.sy-confirm-said'))
        .toContainText('the ground cover', { timeout: UI });
    await a.page.locator('.sy-really').click();
    await expect(a.page.locator('.sy-status'))
        .toContainText('tile(s) to render again', { timeout: UI });
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

test('story 27 — the operator says what the ground is made of',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in as the operator',
            () => signIn(a, 'anna@visp.example', 'Anna'));

        await panel(a, 'Your land');
        await a.page.getByRole('button', { name: 'Go there' }).first().click();
        const here = readCoords(
            await a.page.locator('#standing .coords').textContent());
        expect(here).not.toBeNull();
        const before = await a.page.screenshot({ clip: VIEW });

        await test.step('1 — A adds the two cover sources',
            () => addsSources(a, world));

        // The catalog holds two materials so far (story 20). The wood and the
        // meadow are made of one, the rock and the ice of the other: what this
        // story is about is that the ground is made of something the operator
        // chose, not which picture it is.
        const soft = await sanOf(a, 'Asphalt');
        const hard = await sanOf(a, 'Kerb stone');
        const wood = await sanOf(a, 'Mischwald');

        await test.step('2 — A says what each class is', async () => {
            await panel(a, 'Ground cover');
            await mapsThem(a, 'splatworld:tlm', [
                [TLM.Wald, 'landuse', 'landuse', 'forest'],
                [TLM.Fels, 'natural', 'natural', 'bare_rock'],
                [TLM.Gletscher, 'natural', 'natural', 'glacier'],
            ]);
            await mapsThem(a, 'splatworld:worldcover', [
                [WORLDCOVER.trees, 'landuse', 'landuse', 'forest'],
                [WORLDCOVER.grassland, 'landuse', 'landuse', 'meadow'],
            ]);
        });

        await test.step('4 — and a class nobody mapped says so', () => theUnmapped(a));

        await test.step('A gives each of them a symbol', async () => {
            await paints(a, 'Wood', 'landuse', 'landuse', 'forest', soft, wood);
            await paints(a, 'Rock', 'natural', 'natural', 'bare_rock', hard);
            await paints(a, 'Ice', 'natural', 'natural', 'glacier', hard);
            await paints(a, 'Meadow', 'landuse', 'landuse', 'meadow', soft);
        });

        await test.step('3 — A applies it to the world', () => applies(a));
        await a.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C renders what the cover made stale', () => emptyThePool(c));
        const after = await test.step('and the ground is made of something',
            () => pictureAt(c, world, here));
        expect(differs(before, after), 'the ground changed').toBeGreaterThan(0.001);
        await c.close();
    });
