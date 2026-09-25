// Story 29 — World blocks (TASKS-foundation.md FND.14, PLAN-foundation.md §8).
//
// B stands on their own land and puts down the street lamp C registered in
// story 21 — the one whose head lights up when `on` is set. C, who may build
// there since story 10, opens Automate on that land, draws "Write Port", picks
// the lamp out of the world rather than typing a uuid, chooses `on` off the
// product's own port list, sets it true, and asks whether the flow would run.
//
// Then the file test: what was saved goes out as an .elx and comes back in as
// a copy, and the copy holds the same one World block — not the blocks the
// composite is made of. Which of PLAN-foundation.md §8's two branches writes
// that file is recorded in docs/flow.md; the story is the same either way,
// because what it asserts is what comes back.

import { readFileSync } from 'node:fs';

import { test, expect, looking, open, panel, panelApp, signIn, UI }
    from './players.js';
import { openAutomate } from './automate.js';

const ELX_URL = (process.env.ELX_URL ?? '').trim();

// ------------------------------------------------------------------ the lamp

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// B puts one down and saves it: until the save it is this tab's alone, and a
// flow on the other side of the world cannot name what nobody else can see.
async function bPlantsTheLamp(b, world) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    // Twenty paces along their own land from where story 5 left the bench, so
    // the ground in front of them is bare and a click on it drops the lamp.
    const here = readCoords(await b.page.locator('#standing .coords').textContent());
    await b.page.goto(`${world.pageUrl}#at=${(here.lat + 0.00018).toFixed(5)},`
        + `${here.lon.toFixed(5)},0,0`);
    await looking(b);
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    const search = b.page.locator('.build-search');
    await search.fill('Strassenlampe');
    await search.dispatchEvent('change');
    const row = b.page.locator('.build-asset', { hasText: 'Strassenlampe' }).first();
    await expect(row).toContainText('ports: on (on/off)', { timeout: UI });
    await row.locator('button').click();
    const sel = b.page.locator('.build-sel');
    await expect(sel).toContainText('brush S', { timeout: UI });
    const san = (await sel.textContent()).match(/S[A-Z2-7]{12}/)[0];
    // One click on bare ground drops it. A click where something already
    // stands picks that thing up instead (client/js/buildui.js), which is why
    // the player walked away from story 5's bench first.
    await b.page.mouse.click(640, 520);
    await expect(sel, 'the lamp is the thing being placed')
        .toContainText(san, { timeout: UI });
    await b.page.locator('.build-save').click();
    await expect(b.page.locator('.build-saved'))
        .toContainText('object', { timeout: UI });
    await b.page.locator('.build-toggle').uncheck();
    // Where B is standing and which way they are looking, which is what the
    // address bar is for (SPEC §3.8). C goes to the same place, so the lamp is
    // in front of them too.
    await expect.poll(() => b.page.url(), { timeout: UI }).toContain('#at=');
    return b.page.url();
}

// ------------------------------------------------------------ the flow editor

// Drag one line of the palette onto the canvas, as story 16 does: press on the
// line, move, let go over the canvas.
async function dragIn(player, search, label, at) {
    const palette = player.page.locator('#flows .fl-palette');
    await palette.locator('input').fill(search);
    const line = palette.locator('li', { hasText: label }).first();
    await expect(line).toBeVisible({ timeout: UI });
    const from = await line.boundingBox();
    const box = await player.page.locator('#flows canvas.fl-canvas').boundingBox();
    await player.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await player.page.mouse.down();
    await player.page.mouse.move(box.x + box.width * at[0], box.y + box.height * at[1],
        { steps: 10 });
    await player.page.mouse.up();
}

const nodeNames = (player) => player.page.evaluate(() =>
    (window.splatworld.flows.canvas().graph._nodes ?? []).map((n) => n._irName));

// What the block has been told, read off the graph the way the save reads it.
const constants = (player, name) => player.page.evaluate((want) => {
    const node = (window.splatworld.flows.canvas().graph._nodes ?? [])
        .find((n) => n._irName === want);
    return Object.fromEntries((node?._irConstants ?? [])
        .map((c) => [c.port, c.value?.value?.data ?? '']));
}, name);

// Where an object is on the screen. The player sees the lamp standing there
// and clicks it; the script works out which pixel that is from the camera the
// frame was drawn with — the same aiming story 16 does for a port square.
const objectOnScreen = (player, id) => player.page.evaluate((want) => {
    const { preview, camera, pc, app } = window.splatworld;
    const entity = preview.entities.get(want);
    if (!entity) return null;
    const s = camera.camera.worldToScreen(entity.getPosition(), new pc.Vec3());
    // Behind the camera is not on the screen, whatever the numbers say.
    if (s.z <= 0) return null;
    const r = app.graphicsDevice.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y, metres: s.z };
}, id);

// ------------------------------------------------------------------ the steps

// 1 — C opens Automate on B's land and makes a flow there.
async function newFlow(c) {
    await openAutomate(c);
    await expect(c.page.locator('#flows')).toBeVisible({ timeout: UI });
    // The lands arrive after the view does; New flow asks which one, and it
    // can only ask once it knows.
    await expect(c.page.locator('#flows .fl-list li.land'))
        .toContainText('Ben’s field', { timeout: UI });
    await c.page.locator('#flows .fl-new').click();
    await c.page.locator('#flows .fl-land').selectOption({ label: 'Ben’s field' });
    await c.page.locator('#flows .fl-ask-name').fill('lamp on');
    await c.page.getByRole('button', { name: 'Create' }).click();
    await expect(c.page.locator('#flows .fl-top .name'))
        .toHaveText('lamp on', { timeout: UI });
    // FND.14: the two a World block needs came with the flow, unasked.
    expect(await nodeNames(c)).toEqual(['world', 'world_key']);
}

// 2 — the block, the lamp, the port and the value.
async function writesThePort(c) {
    await dragIn(c, 'world port write', 'Write Port', [0.5, 0.45]);
    expect(await nodeNames(c)).toContain('Write Port');

    // What is on this land, by the product's name: that is how the player
    // knows which of them is the lamp they mean.
    const object = c.page.locator('#flows li[data-port="Object"] select');
    await expect(object, 'the land\'s objects, by what they are')
        .toContainText('Strassenlampe', { timeout: UI });
    const lamp = await object.locator('option').filter({ hasText: 'Strassenlampe' })
        .first().getAttribute('value');
    expect(lamp, 'the lamp has an id in the world').toMatch(/[0-9a-f-]{36}/);

    // Pick in world: Automate goes away, the world asks for a click, and the
    // lamp that was clicked is the object the block writes to.
    await c.page.locator('#flows .fl-pick').click();
    const ask = c.page.locator('#pick-ask');
    await expect(ask).toContainText('click an object on Ben’s field', { timeout: UI });
    await expect.poll(() => objectOnScreen(c, lamp), { timeout: UI }).not.toBeNull();
    const at = await objectOnScreen(c, lamp);
    await c.page.mouse.click(at.x, at.y);
    await expect(ask).toBeHidden({ timeout: UI });
    await expect(c.page.locator('#flows')).toBeVisible({ timeout: UI });
    await expect(object, 'the lamp that was clicked is the one it writes to')
        .toHaveValue(lamp, { timeout: UI });

    // The ports are the product's own (FND.6, db/0160): `on`, and its kind.
    const port = c.page.locator('#flows li[data-port="Port"] select');
    await expect(port, 'the lamp says what it can be told')
        .toContainText('on · boolean', { timeout: UI });
    await port.selectOption('on');

    // A boolean port is a switch, not a line of text to spell "true" into.
    const value = c.page.locator('#flows li[data-port="Value"] input');
    await expect(value).toHaveAttribute('type', 'checkbox', { timeout: UI });
    await value.check();

    const told = await constants(c, 'Write Port');
    expect(told.Port, 'the port it writes').toBe('on');
    expect(told.Value, 'and what it writes there').toBe('true');
    expect(told.Object, 'named by the world, not typed').toBe(lamp);
}

// 3 — and the two flow inputs it now uses cannot be taken away.
async function keepsItsInputs(c) {
    const canvas = c.page.locator('#flows canvas.fl-canvas');
    const box = await canvas.boundingBox();
    await c.page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    const rows = c.page.locator('#flows .fl-inputs li');
    await expect(rows).toHaveCount(2, { timeout: UI });
    for (const name of ['world', 'world_key']) {
        const row = c.page.locator(`#flows .fl-inputs li[data-port="${name}"]`);
        await expect(row.locator('button')).toBeDisabled();
        await expect(row).toContainText('used by World blocks');
    }
}

// 4 — Validate: the page's own check always, the server's when there is one.
async function validates(c) {
    await c.page.locator('#flows .fl-validate').click();
    const check = c.page.locator('#flows .fl-problems');
    await expect(check).toBeVisible({ timeout: UI });
    await expect(check).toContainText('Nothing wrong that this page can see');
    const said = c.page.locator('#flows .fl-said');
    if (ELX_URL) {
        await expect(said, 'the process server said it would run this')
            .toContainText('valid', { timeout: UI });
    } else {
        await expect(said, 'and says plainly that nobody was asked')
            .toContainText('No process server is configured', { timeout: UI });
    }
}

// 5 — saved, exported, imported again: one World block, told the same things.
async function outAndBackIn(c) {
    await c.page.locator('#flows .fl-save').click();
    await expect(c.page.locator('#flows .fl-said')).toHaveText('saved', { timeout: UI });
    const told = await constants(c, 'Write Port');

    const [download] = await Promise.all([
        c.page.waitForEvent('download'),
        c.page.locator('#flows .fl-export').click(),
    ]);
    const text = readFileSync(await download.path(), 'utf8');
    expect(download.suggestedFilename()).toBe('lamp on.elx');

    await c.page.locator('#flows .fl-file').setInputFiles([{ name: 'lamp on.elx',
        mimeType: 'application/xml', buffer: Buffer.from(text) }]);
    await expect(c.page.locator('#flows .fl-said'))
        .toContainText('imported lamp on 2', { timeout: UI });
    await expect(c.page.locator('#flows .fl-top .name'))
        .toHaveText('lamp on 2', { timeout: UI });

    // One World block, not the blocks a composite of it would be made of, and
    // it was told exactly what the first one was told.
    const names = await nodeNames(c);
    expect(names.filter((n) => n.startsWith('Write Port')),
        'the copy has the one World block').toEqual(['Write Port']);
    expect(await constants(c, 'Write Port'), 'saying the same thing').toEqual(told);
    const world = await c.page.evaluate(() =>
        (window.splatworld.flows.canvas().graph._nodes ?? [])
            .filter((n) => n._irPlugin === 'world').length);
    expect(world, 'and it is still a block of the world plugin').toBe(1);
}

test('story 29 — a flow reaches into the world', async ({ browser, world },
    testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    const where = await test.step('and puts a lamp on their land, saved',
        () => bPlantsTheLamp(b, world));
    await b.close();

    const c = await open(browser, world, 'C', testInfo);
    await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
    await test.step('and walks to where the lamp is', async () => {
        await c.page.goto(where);
        await looking(c);
        await expect(c.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
        await expect.poll(() => c.page.evaluate(() => window.splatworld.preview.count),
            { timeout: UI }).toBeGreaterThan(0);
    });

    await test.step('1 — a new flow on B’s land', () => newFlow(c));
    await test.step('2 — Write Port, on the lamp picked out of the world',
        () => writesThePort(c));
    await test.step('3 — world and world_key cannot be removed under it',
        () => keepsItsInputs(c));
    await test.step('4 — Validate says both halves', () => validates(c));
    await test.step('5 — out as a file and back in as a copy', () => outAndBackIn(c));

    await test.step('and the view closes', async () => {
        await panelApp(c, 'Build');
        const box = c.page.locator('#flows .fl-ask');
        if (await box.isVisible()) {
            await box.getByRole('button', { name: 'Discard' }).click();
        }
        await expect(c.page.locator('#flows')).toBeHidden({ timeout: UI });
    });
    await c.close();
});
