// Story 23 — a style reaches the world when somebody says so (FND.8).
//
// B's road from story 19 — `highway=secondary`, `lit=yes` — is submitted,
// approved and rendered: it comes out of the compiler as the migrated symbol
// draws it, a plain surface, because that is the style the world is built
// with. A applies the symbols story 22 saved; the tile goes stale, its rebuild
// is in the pool saying where it came from, and the picture changes. Then A
// edits the symbol again and saves without applying: the counter says so, no
// tile moves, and the picture stays as it was.

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { differs, variety } from './pixels.js';

// A rectangle of the 3D view with no chrome over it (story 8 uses the same).
const VIEW = { x: 690, y: 120, width: 370, height: 240 };

// This story compiles the same ground twice — once as the world is built, once
// as the new symbols build it — and a trained tile is six or seven minutes.
// Every other story fits in the run's fifteen; this one says what it needs.
test.setTimeout(2_400_000);

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const status = (p) => p.page.locator('.po-status');

// Every job in the pool, taken until there is nothing left a tab can take.
// The road is in one tile and the ground above it in another, and which of
// them is which is not this story's business.
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

// 1 — what B drew in QGIS goes through the compiler as it stands.
async function bSendsIt(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    const here = readCoords(await b.page.locator('#standing .coords').textContent());
    await panel(b, 'Submit');
    await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
    await b.page.locator('.su-note').fill('the road from the extract');
    await b.page.locator('.su-mine').click();
    await expect(b.page.locator('.su-status'))
        .toContainText('render job(s) in the pool', { timeout: UI });
    return here;
}

// What the world looks like from where B stands, once it has loaded.
async function pictureAt(p, world, here) {
    await p.page.goto(`${world.pageUrl}#at=${here.lat},${here.lon},0,0`);
    await p.page.waitForFunction(() => Boolean(window.splatworld?.app), null,
        { timeout: 120000 });
    await panel(p, 'Setup');
    await expect(p.page.locator('#world'))
        .toContainText(/[1-9]\d* loaded/, { timeout: RENDER });
    await expect(p.page.locator('#world')).toContainText('published tiles', { timeout: UI });
    const shot = await p.page.screenshot({ clip: VIEW });
    expect(variety(shot), 'there is a world to look at').toBeGreaterThan(20);
    return shot;
}

// 2 — A applies what story 22 saved. The numbers are the world's own.
async function aApplies(a) {
    await panel(a, 'Symbols');
    const changed = a.page.locator('.sy-changed');
    await expect(changed).toContainText('changed since the last apply', { timeout: UI });
    await expect(changed).toContainText('would be rebuilt');
    const before = await changed.textContent();
    const tiles = Number(/(\d+) published tile/.exec(before)?.[1] ?? 0);
    expect(tiles, 'the road is on a published tile').toBeGreaterThan(0);

    await a.page.locator('.sy-apply').click();
    await expect(a.page.locator('.sy-confirm-said'))
        .toContainText(`${tiles} published tile`, { timeout: UI });
    await a.page.locator('.sy-note').fill('the Kantonsstrasse');
    await a.page.locator('.sy-really').click();
    await expect(a.page.locator('.sy-status'))
        .toContainText('tile(s) to render again', { timeout: UI });
    await expect(changed)
        .toHaveText('the world is built with every symbol as it stands', { timeout: UI });
    return tiles;
}

// The rebuild says where it came from, not only that it is there.
async function poolSaysWhy(c) {
    await panel(c, 'Work');
    await expect.poll(async () => {
        await c.page.evaluate(() => window.splatworld.pool.refresh());
        return c.page.locator('.po-list li', { hasText: 'style update' }).count();
    }, { timeout: UI, intervals: [1000] }).toBeGreaterThan(0);
}

// How many jobs a tab could take right now.
async function poolCount(p) {
    await panel(p, 'Work');
    await p.page.evaluate(() => window.splatworld.pool.refresh());
    return p.page.locator('.po-list li', { hasText: 'Render' }).count();
}

// 3 — saved is still not applied.
async function aEditsAgain(a) {
    await panel(a, 'Symbols');
    await a.page.locator('.sy-list .sy-symbol', { hasText: 'Kantonsstrasse' })
        .first().click();
    await expect(a.page.locator('.sy-name')).toHaveValue('Kantonsstrasse', { timeout: UI });
    const lamps = a.page.locator('.sy-stack li').last().locator('.sy-layer');
    await lamps.click();
    await a.page.locator('.sy-layer-form .sy-f-spacing').fill('50');
    await a.page.locator('.sy-layer-form .sy-f-spacing').dispatchEvent('change');
    await a.page.locator('.sy-save').click();
    await expect(a.page.locator('.sy-status'))
        .toContainText('not in the world yet', { timeout: UI });
    await expect(a.page.locator('.sy-changed'))
        .toContainText('1 symbol changed since the last apply', { timeout: UI });
}

test('story 23 — the symbols reach the world when A applies them',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('1 — B sends the road, and approves it',
            () => bSendsIt(b));
        expect(here).not.toBeNull();
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C renders what is waiting', () => emptyThePool(c));
        const plain = await test.step('and the road is there, as the old rules drew it',
            () => pictureAt(c, world, here));
        await c.close();

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in as the operator',
            () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('2 — A applies the symbols', () => aApplies(a));
        await test.step('and the rebuild says where it came from', () => poolSaysWhy(a));
        await test.step('A takes the rebuild', () => emptyThePool(a));
        const styled = await test.step('the same ground, drawn by the new symbol',
            () => pictureAt(a, world, here));
        // The rebuild published — `emptyThePool` waits for that sentence — so
        // the tile is the new symbol's. That it also looks different is the
        // part a person would notice.
        expect(differs(plain, styled), 'the picture changed').toBeGreaterThan(0.0005);

        const left = await test.step('what is still waiting', () => poolCount(a));
        await test.step('3 — A edits it again and saves without applying',
            () => aEditsAgain(a));
        await test.step('and nothing has been queued', async () => {
            expect(await poolCount(a), 'saving queued nothing').toBe(left);
        });
        const after = await pictureAt(a, world, here);
        expect(differs(styled, after), 'and the world still looks as it did')
            .toBeLessThan(0.05);
        await a.close();
    });
