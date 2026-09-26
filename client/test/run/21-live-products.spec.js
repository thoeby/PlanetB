// Story 21 — a model can have parts, and a part can be told things (FND.6).
//
// C registers a street lamp whose head lights up, a billboard whose screen
// shows something, and a tunnel portal whose mouth opens the ground. None of
// that is in the GLB: C says it in the Parts step, and because it is part of
// what the product *is*, the same lamp marked another way is another product.
// B, who places one, is told what it can be told.

import { join } from 'node:path';

import { test, expect, open, panel, signIn, UI } from './players.js';
import { differs } from './pixels.js';
import { REPO } from './world.js';
import { onSale, register, step } from './selling.js';

const fixture = (name) => join(REPO, 'client/test/fixtures/assets', name);

const LAMP = fixture('street-lamp.glb');
const BILLBOARD = fixture('billboard.glb');
const PORTAL = fixture('tunnel-portal.glb');

const said = (c) => c.page.locator('#upload-status');
const marks = (c) => c.page.locator('#form-parts .mk-said');
const preview = (c) => c.page.locator('#preview');

// Pick the file, wait for the canon to have run, and open the node it is
// about — everything in this story starts that way.
async function picks(c, file, name) {
    await onSale(c);
    await c.page.locator('#upload-type').selectOption('model');
    await c.page.locator('#file').setInputFiles(file);
    // The form fills the name in from the file as soon as the canon has run;
    // typing over it before then would race with it.
    await expect(c.page.locator('#canon')).toContainText('tris', { timeout: UI });
    await step(c, 'price');
    await c.page.locator('#name').fill(name);
    await step(c, 'parts');
    await expect(c.page.locator('#form-parts')).toBeVisible({ timeout: UI });
}

const looksAt = async (c, node) => {
    await c.page.locator(`#form-parts .mk-node:has-text("${node}")`).first().click();
    await expect(c.page.locator('#form-parts .mk-node.picked')).toHaveText(node);
};

async function givesRole(c, role) {
    await c.page.locator('#form-parts .mk-role').selectOption(role);
    await expect(marks(c)).not.toHaveText('no live parts', { timeout: UI });
}

const addsPort = async (c, port) => {
    await c.page.locator(`#form-parts .mk-port-${port}`).check();
    await expect(marks(c)).toContainText(`ports: ${port}`, { timeout: UI });
};

const registers = async (c) => {
    await register(c);
    await expect(said(c)).toContainText('published S', { timeout: UI });
    return (await said(c).textContent()).match(/S[A-Z2-7]{12}/)[0];
};

// 1 — the lamp: its head is a light, and flipping `on` lights it.
async function theLamp(c) {
    await picks(c, LAMP, 'Strassenlampe');
    await looksAt(c, 'head');
    await givesRole(c, 'light');
    await addsPort(c, 'on');
    await expect(marks(c)).toContainText('head lights up');

    const off = await preview(c).screenshot();
    await c.page.locator('#form-parts .mk-try-on').check();
    // The head is a small thing on a six-metre mast, so this is a few dozen
    // pixels out of sixty-five thousand — but they are the right ones.
    await expect.poll(async () => differs(off, await preview(c).screenshot()),
        { timeout: UI }).toBeGreaterThan(0.0002);
    return registers(c);
}

// 2 — the billboard: its screen is not baked, so the preview puts a
// placeholder where what it shows will go.
async function theBillboard(c) {
    await picks(c, BILLBOARD, 'Plakatwand');
    const plain = await preview(c).screenshot();
    await looksAt(c, 'screen');
    await givesRole(c, 'screen');
    await addsPort(c, 'image');
    await expect.poll(async () => differs(plain, await preview(c).screenshot()),
        { timeout: UI }).toBeGreaterThan(0.001);
    await registers(c);
}

// 3 — the portal: its mouth is not a part at all, it is a hole in the ground.
async function thePortal(c) {
    await picks(c, PORTAL, 'Tunnelportal');
    await looksAt(c, 'mouth');
    await c.page.locator('#form-parts .mk-opening').check();
    await expect(marks(c)).toContainText('mouth opens the ground', { timeout: UI });
    await registers(c);
}

// 4 — the same file is not the same product. Unmarked it is one thing;
// marked as before it is the one that is already there.
async function theSameLamp(c, lit) {
    await picks(c, LAMP, 'Lampe ohne Licht');
    await expect(c.page.locator('#already')).toHaveText('', { timeout: UI });
    const plain = await registers(c);
    expect(plain).not.toBe(lit);

    await picks(c, LAMP, 'Strassenlampe');
    await looksAt(c, 'head');
    await givesRole(c, 'light');
    await addsPort(c, 'on');
    await expect(c.page.locator('#already'))
        .toHaveText('this is already Strassenlampe by Cara', { timeout: UI });
}

// 5 — B places one, and the list says what it can be told.
async function bPlacesIt(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.build-search');
    await search.fill('Strassenlampe');
    await search.dispatchEvent('change');
    const row = b.page.locator('.build-asset', { hasText: 'Strassenlampe' }).first();
    await expect(row).toContainText('ports: on (on/off)', { timeout: UI });
    await row.locator('button').click();
    await b.page.mouse.click(640, 520);
    await expect(b.page.locator('.build-sel')).toContainText(/placing|selected|Move/i,
        { timeout: UI });
}

test('story 21 — a product can have live parts', async ({ browser, world },
    testInfo) => {
    const c = await open(browser, world, 'C', testInfo);
    await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));

    const lit = await test.step('1 — a lamp whose head lights up', () => theLamp(c));
    await test.step('2 — a billboard whose screen is left live',
        () => theBillboard(c));
    await test.step('3 — a portal whose mouth opens the ground', () => thePortal(c));
    await test.step('4 — the same file, marked and unmarked, is two products',
        () => theSameLamp(c, lit));
    await c.close();

    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    await test.step('5 — B places the lamp, and is told what it can be told',
        () => bPlacesIt(b));
    await b.close();
});
