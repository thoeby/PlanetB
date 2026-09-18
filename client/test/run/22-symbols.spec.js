// Story 22 — what a drawn thing becomes is a symbol (FND.7).
//
// A rule produced a bag of values the compiler knew how to read: `width` meant
// a road. A symbol produces a stack of layers instead — a surface along the
// line, a kerb repeated either side of it, a lamp every thirty metres where
// the road is lit — and the compiler stops knowing what a road is.
//
// A builds one, sees it on a sample of its own kind, and saves it. Nothing
// anybody has published changes: the world is built with the applied style
// until somebody applies this one, which is FND.8's story.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { differs } from './pixels.js';

const said = (a) => a.page.locator('.sy-status');
const preview = (a) => a.page.locator('.sy-preview');

// The catalogue number of a product, found by its name the way a person
// finds it: in the catalog.
async function sanOf(a, name) {
    await panel(a, 'Catalog');
    await a.page.locator('#type').selectOption('');
    await a.page.locator('#q').fill(name);
    await a.page.getByRole('button', { name: 'Find' }).click();
    const card = a.page.locator('#results li', { hasText: name }).first();
    await expect(card).toBeVisible({ timeout: UI });
    return (await card.locator('.san').textContent()).trim();
}

// 1 — the rules of every world before this one are symbols, and they are here.
async function whatIsThere(a) {
    await panel(a, 'Symbols');
    const list = a.page.locator('.sy-list');
    await expect(list).toContainText('any road', { timeout: UI });
    await expect(list).toContainText('any building');
    await expect(list).toContainText('spruce');
    await expect(list.locator('li', { hasText: 'any road' }))
        .toContainText('Surface');
    await expect(list.locator('li', { hasText: 'any building' }))
        .toContainText('Extrude');
}

const addsLayer = async (a, which) => {
    await a.page.locator('.sy-add-layer').selectOption(which);
    await expect(a.page.locator('.sy-stack li').last()).toBeVisible({ timeout: UI });
};

const fills = (a, field, value) =>
    a.page.locator(`.sy-layer-form .sy-f-${field}`).fill(value);

const sets = (a, field, value) =>
    a.page.locator(`.sy-layer-form .sy-f-${field}`).selectOption(value);

// 2 — a road of its own: the surface, a kerb either side, lamps where it is lit.
async function buildsIt(a, products) {
    await panel(a, 'Symbols');
    await a.page.locator('.sy-new').click();
    await a.page.locator('.sy-name').fill('Kantonsstrasse');
    await a.page.locator('.sy-kind').selectOption('highway');
    await a.page.locator('.sy-add-cond').click();
    const cond = a.page.locator('.sy-conds .sy-cond').first();
    await cond.locator('.prop').fill('highway');
    await cond.locator('.val').fill('"secondary"');
    await cond.locator('.val').dispatchEvent('change');

    await addsLayer(a, 'surface');
    await fills(a, 'profile', products.profile);
    await fills(a, 'width', '6');

    await addsLayer(a, 'repeat');
    await fills(a, 'segment', products.kerb);
    await sets(a, 'side', 'both');
    await fills(a, 'offset', '3.2');

    await addsLayer(a, 'repeat');
    await fills(a, 'model', products.lamp);
    await fills(a, 'spacing', '30');
    await sets(a, 'side', 'right');
    await fills(a, 'offset', '4');
    await a.page.locator('.sy-add-lcond').click();
    const only = a.page.locator('.sy-layer-form .sy-lcond').first();
    await only.locator('.prop').fill('lit');
    await only.locator('.val').fill('"yes"');
    await only.locator('.val').dispatchEvent('change');
    await expect(a.page.locator('.sy-stack li')).toHaveCount(3, { timeout: UI });
}

// 3 — the sample says what the layers do, and a property turns one off.
async function theSample(a) {
    await a.page.locator('.sy-add-prop').click();
    const row = a.page.locator('.sy-props .sy-prop').first();
    await row.locator('.prop').fill('lit');
    await row.locator('.val').fill('yes');
    await row.locator('.val').dispatchEvent('change');
    await expect(a.page.locator('.sy-said')).toContainText('meshes', { timeout: UI });
    const lit = await preview(a).screenshot();

    await row.locator('.val').fill('no');
    await row.locator('.val').dispatchEvent('change');
    await expect.poll(async () => differs(lit, await preview(a).screenshot()),
        { timeout: UI }).toBeGreaterThan(0.0005);
}

// 4 — saved is not applied.
async function savesIt(a) {
    await a.page.locator('.sy-save').click();
    await expect(said(a)).toContainText('saved as version 1', { timeout: UI });
    await expect(said(a)).toContainText('not in the world yet');
    await expect(a.page.locator('.sy-list')).toContainText('Kantonsstrasse');
}

// 5 — a repeating piece is not a surface material, and the refusal says so.
async function theRefusal(a, products) {
    await addsLayer(a, 'repeat');
    await fills(a, 'segment', products.asphalt);
    await a.page.locator('.sy-save').click();
    await expect(said(a)).toContainText('repeating piece', { timeout: UI });
    await expect(said(a)).toContainText('is a surface material');
}

test('story 22 — A builds a symbol and sees it on a sample',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in as the operator',
            () => signIn(a, 'anna@visp.example', 'Anna'));

        const products = {};
        await test.step('the products the symbol is built from', async () => {
            products.profile = await sanOf(a, 'Strasse 6 m');
            products.kerb = await sanOf(a, 'Kalksteinmauer 2 m');
            products.lamp = await sanOf(a, 'Strassenlampe');
            products.asphalt = await sanOf(a, 'Asphalt');
        });

        await test.step('1 — every rule this world had is a symbol',
            () => whatIsThere(a));
        await test.step('2 — A builds a road of its own', () => buildsIt(a, products));
        await test.step('3 — the sample shows it, and `lit` turns the lamps off',
            () => theSample(a));
        await test.step('4 — saved, and not in the world yet', () => savesIt(a));
        await test.step('5 — a material cannot be a repeating piece',
            () => theRefusal(a, products));

        await a.close();
    });
