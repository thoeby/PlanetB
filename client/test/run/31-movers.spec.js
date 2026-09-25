// Story 31 — things that move by the world's own clock (FND.16).
//
// B draws a route across his land, puts a bus on it at thirty an hour, every
// five minutes, with one twenty-second stop. A and C, standing at that stop
// with nothing of their own on the land, both see the bus — and both see it in
// the same place at the same second, because neither tab is told where it is:
// each works it out from the same route, the same timetable and the same clock
// (client/lib/route.js, db/0168's `world_clock`).
//
// Nothing here is submitted and nothing is compiled. A bus is not on the land,
// it moves over it.

import { join } from 'node:path';

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { REPO } from './world.js';
import { onSale, register, step } from './selling.js';

const BUS = join(REPO, 'client/test/fixtures/assets/bus.glb');

// How far apart two tabs' idea of where the bus is may be and still be "the
// same bus at the same second". A bus at thirty an hour covers eight metres a
// second; this is a quarter of that.
const TOGETHER_M = 2;

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// A bus is a product like any other, and C is who makes them (story 4).
async function cRegistersABus(c) {
    await onSale(c);
    await c.page.locator('#upload-type').selectOption('model');
    await c.page.locator('#file').setInputFiles(BUS);
    await expect(c.page.locator('#canon')).toContainText('tris', { timeout: UI });
    await step(c, 'price');
    await c.page.locator('#name').fill('Postauto');
    await register(c);
    await expect(c.page.locator('#upload-status'))
        .toContainText('published S', { timeout: UI });
}

async function goesToTheLand(player) {
    await panel(player, 'Your land');
    await player.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await player.page.locator('#standing .coords').textContent());
}

async function stands(player, world, here, north) {
    await player.page.goto(`${world.pageUrl}#at=${(here.lat + north).toFixed(5)},`
        + `${here.lon.toFixed(5)},0,0`);
    await looking(player);
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
}

// 1 — the route, drawn on the ground the way a boundary is, and the bus put on
// it with the timetable the story asks for.
async function drawsTheRoute(b) {
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.mv-search');
    await search.fill('Postauto');
    await search.dispatchEvent('change');
    const found = b.page.locator('.mv-found-one button').first();
    await expect(found).toBeVisible({ timeout: UI });
    await found.click();

    await b.page.locator('.mv-name').fill('Bus 1');
    await b.page.locator('.mv-draw').click();
    await expect(b.page.locator('.mv-said')).toContainText('click the corners',
        { timeout: UI });
    // Each corner in turn, waiting for the ground to answer: a click whose ray
    // finds no ground is not a corner, and the next click must not be counted
    // as it.
    let corners = 0;
    for (const [x, y] of [[520, 520], [640, 520], [760, 520]]) {
        await b.page.mouse.click(x, y);
        corners += 1;
        await expect(b.page.locator('.mv-route'))
            .toContainText(`${corners} corner`, { timeout: UI });
    }
    await b.page.locator('.mv-draw').click();

    await b.page.locator('.mv-speed').fill('30');
    await b.page.locator('.mv-every').fill('5');
    await b.page.locator('.mv-stop-at').fill('5');
    await b.page.locator('.mv-stop-s').fill('20');
    await b.page.locator('.mv-make').click();
    await expect(b.page.locator('.mv-said')).toContainText('on the route',
        { timeout: UI });
    const line = b.page.locator('.mv-one').first();
    await expect(line).toContainText('Bus 1 · 30 km/h · every 5 min · 1 stop',
        { timeout: UI });
    return line.getAttribute('data-mover');
}

// Where one tab thinks the bus is, and what its own clock says: the two things
// two players compare when they say they saw the same bus. `when` is a second
// of the world's own time — asking both tabs about the same second is the
// whole point, and it takes the two reads being a moment apart out of it.
const seenBy = (player, id, when = null) =>
    player.page.evaluate(([want, t]) => {
        const { movers } = window.splatworld;
        const at = movers.where(t ?? movers.clock()).find((m) => m.mover.id === want);
        return at ? { along: at.along, lon: at.lon, lat: at.lat,
            clock: movers.clock() } : null;
    }, [id, when]);

// The second the next run of it starts, by one tab's reading of the world's
// clock. Everything inside the run happens after that.
const departsAt = (player, id) => player.page.evaluate((want) => {
    const { movers } = window.splatworld;
    const row = movers.rows.get(want);
    const every = Math.max(1, Number(row.schedule?.every_s) || 600);
    return Math.ceil(movers.clock() / every) * every - (Number(row.phase_s) || 0);
}, id);

const metresApart = (a, b) => Math.hypot(
    (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180),
    (a.lat - b.lat) * 111320);

// 2 — both of them see it, and both see it in the same place.
async function bothSeeIt(a, c, id) {
    for (const player of [a, c]) {
        await expect.poll(() => player.page.evaluate((want) =>
            window.splatworld.movers.rows.has(want), id),
        { timeout: UI, message: `${player.name} is handed the bus` }).toBe(true);
    }
    expect(Math.abs((await seenBy(a, id)).clock - (await seenBy(c, id)).clock),
        'both tabs read the same clock').toBeLessThan(2);

    // The same second, asked of both: a bus two people are watching is in one
    // place, and neither tab was told where.
    // A tenth of a second after it leaves, and half a second after: both
    // before its stop, so what is being compared is a bus that is moving.
    const leaves = await departsAt(a, id);
    const first = await seenBy(a, id, leaves + 0.1);
    const second = await seenBy(c, id, leaves + 0.1);
    expect(first, 'A sees it').not.toBeNull();
    expect(second, 'C sees it').not.toBeNull();
    expect(metresApart(first, second),
        'and both see the bus in the same place').toBeLessThan(TOGETHER_M);

    // And it is going somewhere: a bus nobody moved is not a bus.
    const later = await seenBy(a, id, leaves + 0.5);
    const alsoLater = await seenBy(c, id, leaves + 0.5);
    expect(Math.abs(later.along - first.along),
        'a moment later it is somewhere else').toBeGreaterThan(2);
    expect(metresApart(later, alsoLater),
        'and C has it in that somewhere else too').toBeLessThan(TOGETHER_M);

    // The readout says when the next one is, and both of them read the same.
    for (const player of [a, c]) {
        await panel(player, 'Place');
        await expect(player.page.locator(`.mv-one[data-mover="${id}"]`))
            .toContainText('next in', { timeout: UI });
    }
    return true;
}

// 3 — B stops it, and both of them see it stand still.
async function pausesIt(b, a, c, id) {
    await b.page.bringToFront();
    await panel(b, 'Place');
    await b.page.locator(`.mv-one[data-mover="${id}"] .mv-pause`).click();
    await expect(b.page.locator('.mv-said')).toContainText('stopped where it is',
        { timeout: UI });

    for (const player of [a, c]) {
        await expect.poll(() => player.page.evaluate((want) =>
            Boolean(window.splatworld.movers.rows.get(want)?.paused), id),
        { timeout: 15_000, message: `${player.name} sees it stop` }).toBe(true);
    }
    // A paused mover is where it was, whatever second you ask about.
    const stood = await seenBy(a, id, 1000);
    const still = await seenBy(a, id, 100000);
    expect(Math.abs(still.along - stood.along),
        'and it is still standing where it stopped').toBeLessThan(0.5);
}

test('story 31 — a bus runs to a timetable, and everybody sees the same one',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('and registers a bus', () => cRegistersABus(c));

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        await stands(b, world, here, 0.00036);

        const id = await test.step('1 — B draws a route and puts a bus on it',
            () => drawsTheRoute(b));
        expect(id, 'the bus is in the world').toMatch(/[0-9a-f-]{36}/);

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('and both stand at the stop', async () => {
            await stands(a, world, here, 0.00036);
            await stands(c, world, here, 0.00036);
        });

        await test.step('2 — both see the same bus in the same place',
            () => bothSeeIt(a, c, id));
        await test.step('3 — B stops it, and both see it stand still',
            () => pausesIt(b, a, c, id));

        await c.close();
        await a.close();
        await b.close();
    });
