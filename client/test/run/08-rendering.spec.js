// Story 8 — rendering (docs/SPEC.md §3.7).
//
// What B approved is in the pool at price 0. C, who owns nothing here and
// built nothing, opens Render, sees what the job is and what it needs of the
// machine, takes it, and watches their own tab compile it (Invariant 9: no
// server computes any of this). It publishes. A, standing where the benches
// are, is in a world that has a tile in it. The coarse tile above goes stale,
// its rebuild appears in the same pool at price 0, and C takes that too.

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { variety } from './pixels.js';

// A rectangle of the 3D view with no chrome over it (story 1 uses the same).
const VIEW = { x: 690, y: 120, width: 370, height: 240 };

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const status = (player) => player.page.locator('.po-status');

async function take(c, row) {
    await row.getByRole('button', { name: 'Render' }).click();
    // What the tab is doing, while it does it: a compile is minutes long.
    await expect(status(c)).toContainText(/assembling|sampling|merging|encoding/,
        { timeout: UI });
    await expect(status(c)).toContainText('is published', { timeout: RENDER });
}

// A third player, who rendered nothing and owns nothing, standing where the
// benches are: the world they load has a tile in it (SPEC §3.7 step 2).
async function aLooks(browser, world, testInfo, here) {
    const a = await open(browser, world, 'A', testInfo);
    await a.page.goto(`${world.pageUrl}#at=${here.lat},${here.lon},0,0`);
    await panel(a, 'Setup');
    await expect(a.page.locator('#world'))
        .toContainText('1 published tiles', { timeout: UI });
    await expect(a.page.locator('#world'))
        .toContainText(/[1-9]\d* loaded/, { timeout: UI });
    // And nothing on that ground is waiting to be rendered any more.
    await expect(a.page.locator('.world-label[data-tone="warn"]'))
        .toHaveCount(0, { timeout: UI });
    expect(variety(await a.page.screenshot({ clip: VIEW })),
        'there is a world to look at').toBeGreaterThan(20);
    await a.close();
}

test('story 8 — C renders what B approved, and the world has it',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        const c = await open(browser, world, 'C', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('C signs in', () => signIn(c, 'cara@visp.example', 'Cara'));

        const here = await test.step('B goes to where they built', async () => {
            await panel(b, 'Your land');
            await b.page.getByRole('button', { name: 'Go there' }).first().click();
            await expect(b.page.locator('#land')).toHaveText('Ben’s field',
                { timeout: UI });
            return readCoords(
                await b.page.locator('#standing .coords').textContent());
        });
        expect(here).not.toBeNull();

        // What story 7 left: the benches were approved, and then a pond was
        // drawn and refused, which moved the land past the version that was
        // approved. Nothing can be compiled for a version the world has left
        // behind (Invariant 3), so the first thing the owner does is ask again
        // for what is there now — and, being the approver, say yes to it.
        await test.step('B sends the land as it stands, and approves it',
            async () => {
                await panel(b, 'Submit');
                await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
                await b.page.locator('.su-note').fill('the benches and the pond');
                await b.page.locator('.su-mine').click();
                await expect(b.page.locator('.su-status'))
                    .toContainText('render job(s) are in the pool', { timeout: UI });
            });

        const fine = c.page.locator('.rows li').filter({ hasText: 'assembled' });
        await test.step('the pool says what the job is and what it needs',
            async () => {
                await panel(c, 'Render pool');
                await expect(fine).toHaveCount(1, { timeout: UI });
                await expect(fine).toContainText('free');
                await expect(fine).toContainText('no GPU needed');
            });

        await test.step('C takes it, and their tab compiles it', () => take(c, fine));

        await test.step('A, elsewhere, stands there and the world has a tile',
            () => aLooks(browser, world, testInfo, here));

        const coarse = c.page.locator('.rows li')
            .filter({ hasText: 'merged from its children' });
        await test.step('the tile above it is stale, and its rebuild is offered',
            async () => {
                await expect(coarse.first()).toBeVisible({ timeout: UI });
                await expect(coarse.first()).toContainText('free');
            });

        await test.step('C takes that too', () => take(c, coarse.first()));

        await b.close();
        await c.close();
    });
