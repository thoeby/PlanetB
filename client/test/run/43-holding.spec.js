// Story 43 — a thing may be held (TASKS-live.md LV.4).
//
// C registers a crate that may be carried. B puts one on his field, picks it
// up, walks a hundred metres and puts it down; A, standing where she can see
// both places, sees it vanish and appear again. Then A and C reach for it at
// the same moment: one of them has it, and the other is told who.

import { test, expect, looking, open, panel, signIn, UI } from './players.js';
import { footOf } from './automate.js';
import { goesToTheLand, plants, registers, stands, whereIs } from './things.js';

const CRATE_AT = { north: 0.0009, east: -0.0004 };
const HUNDRED_M = 0.0009;
// The crate is looked for every eight seconds (play.html showWhatIsAround).
const SWEEP = 20_000;

const has = (p, id) => p.page.evaluate((want) =>
    window.splatworld.preview.rows.get(want) ?? null, id);

async function registersTheCrate(c) {
    await registers(c, 'crate.glb', 'Kiste', [], async () => {
        await c.page.locator('#form-parts .mk-carry-kind').fill('crate');
        await c.page.locator('#form-parts .mk-carry').check();
        await expect(c.page.locator('#form-parts .mk-said'))
            .toContainText('may be carried (crate)', { timeout: UI });
    });
}

// Build mode, and a click where the crate stands: it is selected.
async function selects(p, crate) {
    await panel(p, 'Place');
    await p.page.locator('.build-toggle').check();
    await expect.poll(() => footOf(p, crate), { timeout: SWEEP }).not.toBeNull();
    const at = await footOf(p, crate);
    await p.page.mouse.click(at.x, at.y);
    await expect(p.page.locator('.build-pickup')).toHaveText('Pick up Kiste', { timeout: UI });
}

// Both go to some fifteen metres short of where it is now — near enough to
// click, far enough that it is not under the page's notes at the foot of the
// view — select it, and press Pick up at once.
async function bothReach(world, players, now, crate) {
    const there = `${world.pageUrl}#at=${(now.lat - 0.00014).toFixed(5)},`
        + `${now.lon.toFixed(5)},0,0`;
    for (const p of players) {
        await p.page.goto(there);
        await looking(p);
        await selects(p, crate);
    }
    await Promise.all(players.map((p) => p.page.locator('.build-pickup').click()));
    const said = await Promise.all(players.map(async (p) => {
        await expect(p.page.locator('.build-hold-said')).not.toHaveText('', { timeout: UI });
        return p.page.locator('.build-hold-said').textContent();
    }));
    expect(said.filter((t) => t === 'You have Kiste.'), 'exactly one has it').toHaveLength(1);
    expect(said.find((t) => t !== 'You have Kiste.'), 'and the other is told who does')
        .toMatch(/^(Anna|Cara) has it\.$/);
}

test('story 43 — a crate is carried a hundred metres, and two reach for it at once',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C registers a crate that may be carried', () => registersTheCrate(c));

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        await stands(b, world, here, CRATE_AT.north, CRATE_AT.east);
        const crate = await test.step('B puts the crate down', () => plants(b, 'Kiste'));
        const first = await whereIs(b, crate);

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A stands half way, where she can see both places', async () => {
            await signIn(a, 'anna@visp.example', 'Anna');
            await a.page.goto(`${world.pageUrl}#at=${(first.lat + HUNDRED_M / 2).toFixed(5)},`
                + `${first.lon.toFixed(5)},0,180`);
            await looking(a);
            await expect.poll(() => has(a, crate), { timeout: SWEEP }).not.toBeNull();
        });

        await test.step('1 — B picks it up, and A sees it vanish', async () => {
            await b.page.bringToFront();
            await b.page.locator('.build-pickup').click();
            await expect(b.page.locator('.build-hold-said')).toHaveText('You have Kiste.',
                { timeout: UI });
            await expect(b.page.locator('.build-held-item')).toContainText('Kiste');
            await a.page.bringToFront();
            await expect.poll(() => has(a, crate), { timeout: SWEEP,
                message: 'the crate is gone from where it stood' }).toBeNull();
        });

        await test.step('2 — B walks a hundred metres and puts it down; A sees it again',
            async () => {
                await b.page.bringToFront();
                await stands(b, world, here, CRATE_AT.north + HUNDRED_M, CRATE_AT.east);
                await panel(b, 'Place');
                await b.page.locator('.build-held-item .build-putdown').click();
                await expect(b.page.locator('.build-hold-said'))
                    .toHaveText('You put Kiste down.', { timeout: UI });
                await a.page.bringToFront();
                await expect.poll(async () => (await has(a, crate))?.lat ?? null,
                    { timeout: SWEEP, message: 'the crate is back, a hundred metres on' })
                    .toBeGreaterThan(first.lat + HUNDRED_M * 0.8);
            });
        await b.close();

        await test.step('3 — A and C reach for it at once; one has it, one is told',
            async () => bothReach(world, [a, c], await whereIs(a, crate), crate));
        await a.close();
        await c.close();
    });
