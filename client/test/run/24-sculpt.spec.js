// Story 24 — B shapes his ground (FND.9).
//
// A `terrainmod` polygon can flatten a square. It cannot lay a road bed along a
// road, raise a plateau behind a house and leave a soft edge between them. So a
// land carries a grid of relative metres, and B paints into it: Along line for
// the bed, Raise and Smooth for the plateau, Undo for the stroke he did not
// want. Outside his own land the brush does nothing and says why.
//
// What he saves is one file (docs/rendering.md §6), the tiles it touches go
// dirty, and what comes out of the compiler afterwards is ground that was
// shaped.

import { test, expect, open, panel, signIn, RENDER, UI } from './players.js';
import { differs, variety } from './pixels.js';
import { screenAt } from './editors.js';

test.setTimeout(1_500_000);

const VIEW = { x: 690, y: 120, width: 370, height: 240 };

const said = (b) => b.page.locator('.sc-status');
const summary = (b) => b.page.locator('.sc-said');

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

async function goesToHisLand(b) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await b.page.locator('#standing .coords').textContent());
}

const brush = (b, which) => b.page.locator(`.sc-brush-${which}`).click();

// 1 — the bed under the road he imported in story 19.
async function theBed(b) {
    await panel(b, 'Shape');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    await brush(b, 'line');
    await expect(b.page.locator('.sc-line-box')).toBeVisible();
    const road = b.page.locator('.sc-road');
    await expect(road.locator('option')).not.toHaveCount(1, { timeout: UI });
    await road.selectOption({ index: 1 });
    await b.page.locator('.sc-width').fill('7');
    await b.page.locator('.sc-shoulder').fill('1');
    await b.page.locator('.sc-gradient').fill('8');
    await b.page.locator('.sc-apply').click();
    await expect(said(b)).toContainText('bed laid along', { timeout: UI });
    const words = await said(b).textContent();
    const steepest = Number(/steepest ([\d.]+) %/.exec(words)?.[1] ?? 99);
    expect(steepest, 'the bed is no steeper across than he asked for')
        .toBeLessThanOrEqual(8.001);
}

// Three points of his land on the screen, a short drag's worth apart.
async function onHisLand(b) {
    const c = await screenAt(b, 'inside');
    return [{ x: c.x - 20, y: c.y - 15 }, c, { x: c.x + 20, y: c.y + 15 }];
}

// 2 — a plateau, smoothed, undone, redone. The brush is dragged on the ground
// the way a person drags it. Opening Shape is shaping (EDT.6): there is no
// switch to throw first.
async function thePlateau(b) {
    await expect(said(b)).toContainText('drag on the ground', { timeout: UI });
    await brush(b, 'raise');
    await b.page.locator('.sc-size').fill('20');
    await b.page.locator('.sc-size').dispatchEvent('change');
    await b.page.locator('.sc-strength').fill('1');
    await b.page.locator('.sc-strength').dispatchEvent('change');

    const before = Number(/(\d+) stroke/.exec(await summary(b).textContent())?.[1] ?? 0);
    const here = await onHisLand(b);
    await drag(b, here);
    await expect(summary(b)).toContainText(`${before + 1} strokes unsaved`, { timeout: UI });

    await brush(b, 'smooth');
    await drag(b, here.slice(0, 2));
    await expect(summary(b)).toContainText(`${before + 2} strokes unsaved`, { timeout: UI });

    await b.page.locator('.sc-undo').click();
    await expect(said(b)).toHaveText('undone', { timeout: UI });
    await expect(summary(b)).toContainText(`${before + 1} strokes unsaved`);
    await b.page.locator('.sc-redo').click();
    await expect(said(b)).toHaveText('redone', { timeout: UI });
    await expect(summary(b)).toContainText(`${before + 2} strokes unsaved`);
}

// 2b — the hand. Moving over a field used to mean turning Shape off, walking,
// and turning it back on; and what is on screen while shaping is the clay, not
// the splats, because the clay is what a brush writes into.
async function theHand(b) {
    await expect(b.page.locator('#sculpt-tools')).toBeVisible();
    const hidden = await b.page.evaluate(
        () => window.splatworld.streamer?.hidden?.size ?? 0);
    expect(hidden, 'the splats over the land being shaped are put away')
        .toBeGreaterThan(0);

    await brush(b, 'pan');
    await expect(b.page.locator('.sc-opt-name')).toHaveText('Hand');
    const strokes = await summary(b).textContent();
    const target = () => b.page.evaluate(() => ({ ...window.splatworld.bpmode.cam.state.target }));
    const was = await target();
    const c = await screenAt(b, 'inside');
    await drag(b, [c, { x: c.x + 40, y: c.y + 20 }, { x: c.x + 80, y: c.y + 40 }]);
    expect(await target(), 'the hand moved him over the land').not.toEqual(was);
    await expect(summary(b)).toHaveText(strokes, 'and shaped nothing doing it');
    await brush(b, 'raise');
}

// A drag is a press, some moves and a release — one stroke, one undo.
async function drag(b, points) {
    await b.page.mouse.move(points[0].x, points[0].y);
    await b.page.mouse.down();
    for (const p of points.slice(1)) await b.page.mouse.move(p.x, p.y);
    await b.page.mouse.up();
}

// 3 — a kilometre north is somebody else's ground, or nobody's, and either way
// it is not his to shape. His land is seven hundred metres across, so this is
// the only way to stand off it and still be looking at ground.
async function notHisGround(b, world, here) {
    await b.page.goto(`${world.pageUrl}#at=${here.lat + 0.01},${here.lon},0,0`);
    await b.page.waitForFunction(() => Boolean(window.splatworld?.app), null,
        { timeout: 120000 });
    await panel(b, 'Shape');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    await b.page.waitForFunction(() => window.splatworld.blueprint.active, null,
        { timeout: UI });
    await brush(b, 'raise');
    const off = await screenAt(b, 'outside');
    expect(off, 'ground off his land is in view').not.toBeNull();
    await drag(b, [off, { x: off.x + 10, y: off.y + 5 }, { x: off.x + 20, y: off.y + 10 }]);
    await expect(said(b)).toHaveText('You can only shape your own land',
        { timeout: UI });
}

// 4 — saved, sent, approved, rendered.
async function savesIt(b) {
    await b.page.locator('.sc-save').click();
    await expect(said(b)).toContainText('ground saved', { timeout: UI });
    await expect(said(b)).toContainText('tile(s) changed');
    await b.page.keyboard.press('Escape');
}

async function sendsIt(b) {
    await panel(b, 'Submit');
    await expect(b.page.locator('.su-changes'))
        .toContainText('ground shaped', { timeout: UI });
    await expect(b.page.locator('.su-mine')).toBeEnabled({ timeout: UI });
    await b.page.locator('.su-note').fill('the road bed and the plateau');
    await b.page.locator('.su-mine').click();
    await expect(b.page.locator('.su-status'))
        .toContainText('render job(s) in the pool', { timeout: UI });
}

const status = (p) => p.page.locator('.po-status');

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

async function pictureAt(p, world, here) {
    await p.page.goto(`${world.pageUrl}#at=${here.lat},${here.lon},0,0`);
    await p.page.waitForFunction(() => Boolean(window.splatworld?.app), null,
        { timeout: 120000 });
    await panel(p, 'Setup');
    await expect(p.page.locator('#world'))
        .toContainText(/[1-9]\d* loaded/, { timeout: RENDER });
    const shot = await p.page.screenshot({ clip: VIEW });
    expect(variety(shot), 'there is a world to look at').toBeGreaterThan(20);
    return shot;
}

test('story 24 — B shapes his ground, and the world is rendered with it',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('B goes to his land', () => goesToHisLand(b));
        expect(here).not.toBeNull();
        const before = await b.page.screenshot({ clip: VIEW });

        await test.step('1 — a bed along his road', () => theBed(b));
        await test.step('2 — a plateau, smoothed, undone and redone',
            () => thePlateau(b));
        await test.step('2b — the hand moves him over it, and shapes nothing',
            () => theHand(b));
        await test.step('3 — saved, and sent', async () => {
            await savesIt(b);
            await sendsIt(b);
        });
        await test.step('4 — and nothing at all off his own land',
            () => notHisGround(b, world, here));
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C renders what is waiting', () => emptyThePool(c));
        const after = await test.step('and the ground somebody shaped is what is there',
            () => pictureAt(c, world, here));
        expect(differs(before, after), 'the ground moved').toBeGreaterThan(0.001);
        await c.close();
    });
