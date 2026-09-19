// Story 20 — a product is not always a model (FND.5).
//
// C registers the four other kinds of thing a symbol is built from: a wall
// segment that repeats, two surface materials, a road's cross-section, and a
// collection of trees. None of them is placed on the land, so none of them is
// in the Place panel — they are what a symbol reaches for, and the catalog is
// where they are made, named, licensed and paid for like anything else.

import { join } from 'node:path';

import { test, expect, open, panel, signIn, UI } from './players.js';
import { REPO } from './world.js';

const fixture = (name) => join(REPO, 'client/test/fixtures/assets', name);

const WALL = fixture('wall-segment-2m.glb');
const CRUMB = fixture('pebble-segment-5cm.glb');
const ASPHALT = fixture('asphalt.png');
const KERB = fixture('kerb-stone.png');
const HUGE = fixture('too-big.png');

const said = (c) => c.page.locator('#upload-status');

async function registers(c, type, name, fill) {
    await panel(c, 'Catalog');
    await c.page.locator('#upload-type').selectOption(type);
    await c.page.locator('#name').fill(name);
    await fill();
    await c.page.locator('#publish').click();
}

// 1 — a repeating piece says how long its repeat is.
async function theWall(c) {
    await registers(c, 'segment', 'Kalksteinmauer 2 m',
        () => c.page.locator('#file').setInputFiles(WALL));
    await expect(said(c)).toContainText('repeats every 2.00 m', { timeout: UI });
}

// 2 — two materials, each a square png with a tiling size.
async function theMaterials(c) {
    for (const [name, file, tiling] of [['Asphalt', ASPHALT, '4'],
        ['Kerb stone', KERB, '1']]) {
        await registers(c, 'material', name, async () => {
            await c.page.locator('#material-file').setInputFiles(file);
            await c.page.locator('#material-tiling').fill(tiling);
            await c.page.locator('#material-tiling').dispatchEvent('change');
            await expect(c.page.locator('#material-said'))
                .toContainText('256 × 256 px', { timeout: UI });
        });
        await expect(said(c)).toContainText('published S', { timeout: UI });
    }
    // The catalogue numbers the cross-section is built from, read off the
    // cards the way a person reads them.
    return { asphalt: await sanOf(c, 'Asphalt'), kerb: await sanOf(c, 'Kerb stone') };
}

// The catalogue number of a product, found by its name.
async function sanOf(c, name) {
    await c.page.locator('#type').selectOption('');
    await c.page.locator('#q').fill(name);
    await c.page.getByRole('button', { name: 'Find' }).click();
    const card = c.page.locator('#results li', { hasText: name }).first();
    await expect(card).toBeVisible({ timeout: UI });
    return (await card.locator('.san').textContent()).trim();
}

// 3 — a road's cross-section: asphalt across the middle, a kerb either side.
async function theProfile(c, mats) {
    await registers(c, 'profile', 'Strasse 6 m', async () => {
        const add = c.page.locator('#form-profile .pf-add');
        await add.click();
        await add.click();
        const rows = c.page.locator('#form-profile .strip');
        await expect(rows).toHaveCount(2, { timeout: UI });
        await rows.nth(0).locator('.st-offset').fill('0');
        await rows.nth(0).locator('.st-width').fill('6');
        await rows.nth(0).locator('.st-material').fill(mats.asphalt);
        await rows.nth(1).locator('.st-offset').fill('3.15');
        await rows.nth(1).locator('.st-width').fill('0.3');
        await rows.nth(1).locator('.st-height').fill('0.12');
        await rows.nth(1).locator('.st-material').fill(mats.kerb);
        await c.page.locator('#form-profile .pf-mirrored').check();
        // The preview says what was typed, in metres across.
        await expect(c.page.locator('#form-profile .pf-said'))
            .toContainText('6.60 m across', { timeout: UI });
    });
    await expect(said(c)).toContainText('published S', { timeout: UI });
}

// 4 — a collection: three larches to one fir. The two trees are models, so
// they are registered the way story 4 registered the bench.
async function theTrees(c) {
    for (const [name, file] of [['Larch', fixture('tree-larch.glb')],
        ['Fir', fixture('tree-fir.glb')]]) {
        await registers(c, 'model', name,
            () => c.page.locator('#file').setInputFiles(file));
        await expect(said(c)).toContainText('published S', { timeout: UI });
    }
}

async function theCollection(c) {
    await registers(c, 'collection', 'Mischwald', async () => {
        const search = c.page.locator('#form-collection .cl-search');
        for (const name of ['Larch', 'Fir']) {
            await search.fill(name);
            await search.dispatchEvent('change');
            const add = c.page.locator(`#form-collection .cl-found button:has-text("${name}")`);
            await expect(add.first()).toBeVisible({ timeout: UI });
            await add.first().click();
        }
        const rows = c.page.locator('#form-collection .members li');
        await expect(rows).toHaveCount(2, { timeout: UI });
        await rows.nth(0).locator('.cl-weight').fill('3');
        await expect(c.page.locator('#form-collection .cl-said'))
            .toContainText('2 in it', { timeout: UI });
    });
    await expect(said(c)).toContainText('published S', { timeout: UI });
}

// 5 — none of them is placed, and the catalog finds them by what they are.
async function whereTheyAreNot(c) {
    await panel(c, 'Catalog');
    await c.page.locator('#type').selectOption('collection');
    await c.page.locator('#q').fill('');
    await c.page.getByRole('button', { name: 'Find' }).click();
    await expect(c.page.locator('#results')).toContainText('Mischwald', { timeout: UI });
    await expect(c.page.locator('#results')).not.toContainText('Asphalt');
    await c.page.locator('#type').selectOption('');
}

// 6 — each refusal, in its own sentence.
async function theRefusals(c) {
    await registers(c, 'segment', 'Kieselstein',
        () => c.page.locator('#file').setInputFiles(CRUMB));
    await expect(said(c)).toContainText('at least 0.10 m long', { timeout: UI });

    await registers(c, 'material', 'Riesenkies', async () => {
        await c.page.locator('#material-file').setInputFiles(HUGE);
        await c.page.locator('#material-tiling').fill('4');
        await c.page.locator('#material-tiling').dispatchEvent('change');
    });
    await expect(said(c)).toContainText('at most 2048 px', { timeout: UI });
}

test('story 20 — the catalog holds five kinds of thing',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));

        await test.step('1 — a wall that repeats every two metres', () => theWall(c));
        const mats = await test.step('2 — two surface materials', () => theMaterials(c));
        await test.step('3 — a road, in cross-section', () => theProfile(c, mats));
        await test.step('4 — two trees, and a collection of them', async () => {
            await theTrees(c);
            await theCollection(c);
        });
        await test.step('5 — none of them is a thing you place',
            () => whereTheyAreNot(c));
        await test.step('6 — and each refusal says what is wrong',
            () => theRefusals(c));

        await c.close();
    });
