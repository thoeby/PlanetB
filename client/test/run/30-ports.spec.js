// Story 30 — a thing can be told things (TASKS-foundation.md FND.15).
//
// B switches his lamp on from the Place panel, and A — standing a short way
// off, who has been told nothing and pressed nothing — sees it light up within
// ten seconds. Nothing is compiled: the tile under the lamp is exactly the
// tile it was, and what changed is drawn over it (client/js/livedraw.js).
//
// Then the one live change that is not immediate. A billboard's picture is
// somebody else's advertisement, so B setting it does not put it in front of
// anybody: A goes on seeing what was there until the land's approver says yes
// (D13). And C, who may not build here, is shown the same ports and may touch
// none of them.

import { test, expect, looking, open, panel, signIn, signUp, UI } from './players.js';
import { differs } from './pixels.js';

// The picture a board is given: a material somebody registered in story 20,
// which is what the world has to show.
const PICTURE = 'Asphalt';

// How long a player waits for somebody else's lamp: the sweep is every three
// seconds (client/js/live.js), so ten covers three of them.
const LIVE = 10_000;

// ------------------------------------------------------------- the pictures

// Where the live part of a placed thing is on the screen, and a box around it.
// The part, not the thing: a lamp's head is six metres up its mast, and a box
// around where the mast meets the ground has no lamp in it at all. The player
// sees the head; the script works out which pixels that is, the way story 29
// works out which pixel to click.
const boxOf = (player, id, part = null, half = 110) =>
    player.page.evaluate(([want, which, pad]) => {
        const { preview, camera, pc, app } = window.splatworld;
        const entity = preview.entities.get(want);
        if (!entity) return null;
        const kid = which ? preview.partsOf(want).get(which) : null;
        const aabb = (kid ?? entity).render?.meshInstances?.[0]?.aabb;
        const s = camera.camera.worldToScreen(aabb ? aabb.center : entity.getPosition(),
            new pc.Vec3());
        if (s.z <= 0) return null;
        const r = app.graphicsDevice.canvas.getBoundingClientRect();
        const x = Math.round(Math.min(Math.max(r.left + s.x - pad, 0), r.width - 2 * pad));
        const y = Math.round(Math.min(Math.max(r.top + s.y - pad, 0), r.height - 2 * pad));
        return { x, y, width: 2 * pad, height: 2 * pad };
    }, [id, part, half]);

const shotOf = (player, box) => player.page.screenshot({ clip: box });

// Where a thing meets the ground, on the screen. That is where you click to
// pick it up: the pointer's ray lands on the heightfield, and what is standing
// within a few metres of where it lands is what was clicked
// (client/js/buildui.js).
const footOf = (player, id) => player.page.evaluate((want) => {
    const { preview, camera, pc, app } = window.splatworld;
    const entity = preview.entities.get(want);
    if (!entity) return null;
    const s = camera.camera.worldToScreen(entity.getPosition(), new pc.Vec3());
    if (s.z <= 0) return null;
    const r = app.graphicsDevice.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
}, id);

// What one tab has actually put on a board: the sha256 of the picture its
// screen part is drawn with.
//
// Not a picture of it. A canonical GLB carries positions and normals and no
// texture coordinates (client/lib/glbmesh.js), so a picture on a screen is a
// flat wash of one of its colours rather than the picture — which is a
// comparison that proves nothing about whether the right picture arrived.
// What the tab is drawing with is the thing worth asserting.
const showing = (player, id) => player.page.evaluate((want) =>
    window.splatworld.liveDraw.extra.get(want)?.get('screen')?.showing ?? null, id);

// ------------------------------------------------------------- the placing

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

async function goesToTheLand(player) {
    await panel(player, 'Your land');
    await player.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await player.page.locator('#standing .coords').textContent());
}

// A few paces along the land, so the ground in front is bare: a click where
// something already stands picks that thing up rather than placing (story 29).
async function stands(player, world, here, north) {
    await player.page.goto(`${world.pageUrl}#at=${(here.lat + north).toFixed(5)},`
        + `${here.lon.toFixed(5)},0,0`);
    await looking(player);
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return player.page.url();
}

const thingsOn = (player) => player.page.evaluate(() =>
    [...window.splatworld.preview.rows.keys()].filter((id) => !String(id).startsWith('placing:')));

// One product from the catalog, put down on bare ground and saved. Returns the
// id the world gave it — what the Ports section is about, and what A's tab
// draws.
async function plants(b, name) {
    const before = new Set(await thingsOn(b));
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.build-search');
    await search.fill(name);
    await search.dispatchEvent('change');
    const row = b.page.locator('.build-asset', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: UI });
    await row.locator('button').click();
    const sel = b.page.locator('.build-sel');
    await expect(sel).toContainText('brush S', { timeout: UI });
    const san = (await sel.textContent()).match(/S[A-Z2-7]{12}/)[0];
    await b.page.mouse.click(640, 520);
    await expect(sel).toContainText(san, { timeout: UI });
    await b.page.locator('.build-save').click();
    await expect(b.page.locator('.build-saved')).toContainText('object', { timeout: UI });
    await expect.poll(async () =>
        (await thingsOn(b)).filter((id) => !before.has(id)).length,
    { timeout: UI }).toBe(1);
    // Saved, and then picked up again: what was being placed was this tab's
    // alone, and the Ports section is about a thing the world knows.
    await b.page.mouse.click(640, 520);
    await expect(b.page.locator('.build-ports-section'))
        .toBeVisible({ timeout: UI });
    return (await thingsOn(b)).find((id) => !before.has(id));
}

// ------------------------------------------------------------------ the steps

// 1 — B switches the lamp on, and A sees it.
async function switchesItOn(b, a, lamp) {
    const box = await boxOf(a, lamp, 'head');
    expect(box, 'A can see where the lamp is').not.toBeNull();
    const dark = await shotOf(a, box);

    await b.page.locator('.build-ports li[data-port="on"] input').check();
    await expect(b.page.locator('.build-ports-said')).toContainText('on set',
        { timeout: UI });

    // A was told nothing and pressed nothing: the world reached them.
    await expect.poll(() => a.page.evaluate((id) =>
        window.splatworld.live.at(id, 'on'), lamp),
    { timeout: LIVE, message: 'A is told the lamp is on' }).toBe(true);
    // And it shows: the pixels where the lamp stands are not the pixels they
    // were. A lamp head is a small thing on a six-metre mast, so this is a few
    // hundred pixels out of fifty thousand — but they are the right ones.
    await expect.poll(async () => differs(dark, await shotOf(a, box)),
        { timeout: LIVE, message: 'A sees the lamp light up' }).toBeGreaterThan(0.0005);
}

// 2 — B gives the billboard a picture, and nobody else sees it yet.
async function setsTheScreen(b, a, board, png) {
    const box = await boxOf(a, board, 'screen');
    const before = await shotOf(a, box);

    const image = b.page.locator('.build-ports li[data-port="image"]');
    await image.locator('.pt-picture').fill(png);
    await image.locator('.pt-picture').dispatchEvent('change');
    await image.locator('.pt-material button').first().click();
    await expect(b.page.locator('.build-ports-said'))
        .toContainText('shown to others after approval', { timeout: UI });
    // And the row itself says so, which is what B sees when they look again.
    await expect(image).toContainText('waiting for approval', { timeout: UI });
    const picture = await b.page.evaluate(() =>
        window.splatworld.build.ports.state.live?.image?.pending ?? null);
    expect(picture, 'what B chose is waiting on it').toMatch(/^[0-9a-f]{64}$/);

    // Ten seconds is three sweeps: long enough that "not yet" is a fact.
    await a.page.waitForTimeout(LIVE);
    expect(differs(before, await shotOf(a, box)),
        'A still sees the board as it was').toBeLessThan(0.0005);
    expect(await showing(a, board), 'and their tab is drawing nothing on it')
        .toBeNull();
    return { box, before, board, picture };
}

// 3 — the land's approver says yes, and then everybody sees it.
async function approves(b, a, seen) {
    await panel(b, 'Permission');
    const screens = b.page.locator('.scr-list li.scr-screen');
    await expect(screens).toHaveCount(1, { timeout: UI });
    await screens.first().locator('.scr-yes').click();
    await expect(b.page.locator('.scr-status'))
        .toContainText('everybody sees now', { timeout: UI });

    // A was told nothing and pressed nothing: the approval reached them the
    // same way the lamp did, and their tab put that picture on the board.
    await expect.poll(() => showing(a, seen.board),
        { timeout: LIVE, message: 'A sees the new picture' }).toBe(seen.picture);
}

// 4 — somebody who may not build here is shown the ports and may touch none.
//
// Not C: C asked for a build grant on this land in story 10 and was given one,
// so a lamp on it is theirs to switch as much as it is B's. This is a stranger
// — the world's fourth player, walking past.
async function strangerLooks(d, where, lamp) {
    await d.page.goto(where);
    await looking(d);
    await expect(d.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await panel(d, 'Place');
    await expect(d.page.locator('.build-where'))
        .toContainText('you may not build here', { timeout: UI });
    await d.page.locator('.build-toggle').check();
    await expect.poll(() => d.page.evaluate((id) =>
        Boolean(window.splatworld.preview.entities.get(id)), lamp),
    { timeout: UI }).toBe(true);
    const at = await footOf(d, lamp);
    expect(at, 'they can see where the lamp stands').not.toBeNull();
    await d.page.mouse.click(at.x, at.y);
    const on = d.page.locator('.build-ports li[data-port="on"] input');
    await expect(on, 'they are shown what the lamp can be told')
        .toBeVisible({ timeout: UI });
    await expect(on, 'and may not tell it any of it').toBeDisabled();
    await expect(d.page.locator('.build-ports-said')).toContainText('read-only');
}

test('story 30 — a lamp is switched on, and everybody sees it',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        const byTheLamp = await stands(b, world, here, 0.00036);

        const lamp = await test.step('B puts a lamp down and saves it',
            () => plants(b, 'Strassenlampe'));
        expect(lamp, 'the lamp is in the world').toMatch(/[0-9a-f-]{36}/);

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('and stands where they can see it', async () => {
            await a.page.goto(byTheLamp);
            await looking(a);
            await expect.poll(() => a.page.evaluate((id) =>
                Boolean(window.splatworld.preview.entities.get(id)), lamp),
            { timeout: UI }).toBe(true);
        });

        await test.step('1 — B switches it on and A sees it light up', async () => {
            await b.page.bringToFront();
            await switchesItOn(b, a, lamp);
        });

        // The billboard, and the one live change that waits for a person.
        const byTheBoard = await stands(b, world, here, 0.00054);
        const board = await test.step('B puts a board down too',
            () => plants(b, 'Plakatwand'));
        await test.step('and A goes to stand in front of it', async () => {
            await a.page.goto(byTheBoard);
            await looking(a);
            await expect.poll(() => a.page.evaluate((id) =>
                Boolean(window.splatworld.preview.entities.get(id)), board),
            { timeout: UI }).toBe(true);
        });
        const seen = await test.step('2 — B gives it a picture, and A sees the old one',
            async () => {
                await b.page.bringToFront();
                return setsTheScreen(b, a, board, PICTURE);
            });
        await test.step('3 — the approver says yes, and then A sees it',
            () => approves(b, a, seen));

        const d = await open(browser, world, 'D', testInfo);
        await test.step('a fourth player joins the world',
            () => signUp(d, 'dora@visp.example', 'Dora'));
        await test.step('4 — a stranger is shown the ports and may touch none',
            () => strangerLooks(d, byTheLamp, lamp));

        await d.close();
        await a.close();
        await b.close();
    });
