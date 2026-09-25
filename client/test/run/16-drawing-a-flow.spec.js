// Story 16 — drawing a flow (TASKS-foundation.md FND.1, docs/SPEC.md §2.16).
//
// A takes a piece of land of their own, opens Automate, draws a small flow out
// of standard blocks, saves it, reloads the page and finds it exactly as it
// was. B, who has nothing on that land, cannot see it; C, who builds there,
// can open and change it.
//
// The ports are the ones the bundled plugins actually declare: strings'
// Contains takes `string` and `substring` and gives `contains`, so the constant
// goes on `substring` rather than on FND.1's shorthand "pattern". The searches
// name the group as well as the block, because two plugins have a Contains and
// a player picking off a list picks the one they meant.

import { test, expect, open, panel, panelApp, shows, signIn, UI }
    from './players.js';
import { differs, variety } from './pixels.js';
import { openAutomate } from './automate.js';

const PATCH = [[0.20, 0.22], [0.34, 0.22], [0.34, 0.36], [0.20, 0.36]];

// A's own land, by story 2's route: A asks for land like anybody else, and
// then — being the admin — draws it and hands it over. The admin assigning to
// themselves is not a special path; it is the same request row.
async function bergli(a) {
    await panel(a, 'Your land');
    await a.page.getByLabel('what land do you want').fill('a strip above Visp');
    await a.page.getByRole('button', { name: 'Request land' }).click();
    await shows(a, 'with the admin');

    await panel(a, 'Land');
    // By this story other people have asked for land too (story 11 asks again),
    // so the admin picks the ask they are answering rather than whichever was
    // at the top of the list.
    await a.page.locator('.assign-requests button', { hasText: 'Anna' }).first().click();
    const map = a.page.locator('#assign-map');
    await expect(map).toBeVisible({ timeout: UI });
    await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    for (const [fx, fy] of PATCH) {
        await a.page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    }
    await a.page.getByRole('button', { name: 'Finish the boundary' }).click();
    await a.page.getByLabel('name this land').fill('Bergli');
    await a.page.getByRole('button', { name: 'Assign this land' }).click();
    await shows(a, 'assigned to Anna');
}

// Where a node's port is on the screen. The player aims at a square they can
// see; the script works out where that square is from the same numbers the
// canvas drew it with, and then really presses the mouse there.
async function portAt(player, name, { input, slot = 0 }) {
    const at = await player.page.evaluate(([nodeName, isInput, index]) => {
        const canvas = window.splatworld.flows.canvas();
        const node = (canvas.graph._nodes ?? []).find((n) => n._irName === nodeName);
        if (!node) throw new Error(`no node called ${nodeName}`);
        const pos = node.getConnectionPos(isInput, index);
        const el = canvas.view.convertOffsetToCanvas([pos[0], pos[1]]);
        const r = canvas.view.canvas.getBoundingClientRect();
        return { x: r.left + el[0], y: r.top + el[1] };
    }, [name, input, slot]);
    return at;
}

// Selecting a block the way a player does: a press on its title bar.
async function selectBlock(player, name) {
    const at = await player.page.evaluate((nodeName) => {
        const canvas = window.splatworld.flows.canvas();
        const node = (canvas.graph._nodes ?? []).find((n) => n._irName === nodeName);
        if (!node) throw new Error(`no node called ${nodeName}`);
        const title = window.LiteGraph.NODE_TITLE_HEIGHT;
        const el = canvas.view.convertOffsetToCanvas(
            [node.pos[0] + node.size[0] / 2, node.pos[1] - title / 2]);
        const r = canvas.view.canvas.getBoundingClientRect();
        return { x: r.left + el[0], y: r.top + el[1] };
    }, name);
    await player.page.mouse.click(at.x, at.y);
}

async function wire(player, from, to) {
    const a = await portAt(player, from.node, { input: false, slot: from.slot ?? 0 });
    const b = await portAt(player, to.node, { input: true, slot: to.slot ?? 0 });
    await player.page.mouse.move(a.x, a.y);
    await player.page.mouse.down();
    await player.page.mouse.move(b.x, b.y, { steps: 12 });
    await player.page.mouse.up();
}

// Drag one line of the palette onto the canvas, where a player would drop it:
// press on the line, move, let go over the canvas.
async function dragIn(player, search, label, at) {
    const palette = player.page.locator('#flows .fl-palette');
    await palette.locator('input').fill(search);
    const line = palette.locator('li', { hasText: label }).first();
    await expect(line).toBeVisible({ timeout: UI });
    const from = await line.boundingBox();
    const canvas = player.page.locator('#flows canvas.fl-canvas');
    const box = await canvas.boundingBox();
    const to = { x: box.x + box.width * at[0], y: box.y + box.height * at[1] };
    await player.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await player.page.mouse.down();
    await player.page.mouse.move(to.x, to.y, { steps: 10 });
    await player.page.mouse.up();
}

// A press on the canvas where nothing is, so the inspector is about the flow
// rather than about a block.
async function clickEmpty(player) {
    const canvas = player.page.locator('#flows canvas.fl-canvas');
    const box = await canvas.boundingBox();
    await player.page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
}

const names = (player) => player.page.evaluate(() =>
    (window.splatworld.flows.canvas().graph._nodes ?? []).map((n) => n._irName));

// FND.14: every flow is made with these two, because a World block put into it
// later has nothing to reach the world with otherwise. They are inputs like any
// other until one is there to use them.
const WORLD = ['world', 'world_key'];

// 3 — two blocks, the flow's own input and output, and the wires between them.
async function draws(a) {
    await dragIn(a, 'bytes from string', 'From String', [0.35, 0.3]);
    await dragIn(a, 'strings contains', 'Contains', [0.65, 0.6]);
    expect(await names(a)).toEqual([...WORLD, 'From String', 'Contains']);

    // What somebody calling this flow passes in and gets back. They are added
    // with nothing selected, which is when the inspector is about the flow.
    await clickEmpty(a);
    await a.page.locator('#flows .fl-add-input').click();
    // The one just added, which is the last of the three: the other two are
    // the world's, and they came with the flow.
    const added = a.page.locator('#flows .fl-inputs li').last();
    await added.locator('input').fill('Target');
    await added.locator('input').blur();
    await added.locator('select').selectOption('string');
    await a.page.locator('#flows .fl-add-output').click();
    await a.page.locator('#flows .fl-outputs input').fill('Found');
    await a.page.locator('#flows .fl-outputs input').blur();
    await a.page.locator('#flows .fl-outputs select').selectOption('boolean');

    await wire(a, { node: 'Target' }, { node: 'Contains', slot: 0 });
    await wire(a, { node: 'Contains' }, { node: 'Found' });
    const wired = await a.page.evaluate(() => {
        const g = window.splatworld.flows.canvas().graph;
        const node = g._nodes.find((n) => n._irName === 'Contains');
        return { in: node.inputs[0].link !== null, out: node.outputs[0].links?.length ?? 0 };
    });
    expect(wired.in, 'Target reaches Contains').toBe(true);
    expect(wired.out, 'Contains reaches Found').toBeGreaterThan(0);
}

// A value typed onto the one input no wire reaches.
async function constant(a) {
    await clickEmpty(a);
    await selectBlock(a, 'Contains');
    const row = a.page.locator('#flows li[data-port="substring"] input');
    await expect(row).toBeVisible({ timeout: UI });
    await row.fill('dusk');
    await row.blur();
}

// 4 — a name another block already has, and then one nobody has.
async function renames(a) {
    const name = a.page.locator('#flows .fl-name');
    await name.fill('From String');
    await name.blur();
    await expect(a.page.locator('#flows .fl-inspect .fl-err'))
        .toContainText('is already used in this flow', { timeout: UI });
    await name.fill('Is it dusk');
    await name.blur();
    expect(await names(a)).toContain('Is it dusk');
}

// 5 — undo twice, redo once, on the top bar's two glyphs (UI.8). Each
// step of the history is the flow as it would have been saved, so what it went
// back to is compared as the ELX itself.
async function undoRedo(a) {
    const elx = () => a.page.evaluate(() => window.splatworld.flows.canvas().elx());
    const before = await elx();
    await a.page.locator('#bar-undo').click();
    const once = await elx();
    await a.page.locator('#bar-undo').click();
    const twice = await elx();
    expect(once, 'one undo went back a step').not.toBe(before);
    expect(twice, 'and the second went back another').not.toBe(once);
    await a.page.locator('#bar-redo').click();
    expect(await elx(), 'the redo came forward exactly one').toBe(once);
    // And forward again to where the drawing was left, so what is saved next
    // is the whole flow.
    await a.page.locator('#bar-redo').click();
    expect(await elx()).toBe(before);
}

async function picture(player) {
    const state = await player.page.evaluate(() => {
        const c = window.splatworld.flows.canvas();
        return { elx: c.elx(), pos: (c.graph._nodes ?? []).map((n) => [n._irName, ...n.pos]) };
    });
    const shot = await player.page.locator('#flows canvas.fl-canvas').screenshot();
    return { ...state, shot };
}

// 6 — saved, and the same flow after the page has been thrown away and reopened.
async function savesAndReloads(a) {
    await a.page.locator('#flows .fl-save').click();
    await expect(a.page.locator('#flows .fl-said')).toHaveText('saved', { timeout: UI });
    await expect(a.page.locator('#flows .fl-dirty')).toBeHidden();
    const was = await picture(a);

    await a.page.reload();
    await a.page.waitForFunction(() => window.splatworld?.flows, null, { timeout: UI });
    await openAutomate(a);
    await a.page.locator('#flows .fl-list li[data-flow] button.pick').click();
    await expect(a.page.locator('#flows .fl-top .name'))
        .toHaveText('lamp at dusk', { timeout: UI });
    const now = await picture(a);
    expect(now.elx, 'the flow came back byte for byte').toBe(was.elx);
    expect(now.pos, 'and so did every box, where it was left').toEqual(was.pos);
    // And it looks the same: the canvas is drawn from the same graph, so the
    // two pictures differ in almost no pixels at all.
    expect(variety(was.shot), 'there was something drawn to compare').toBeGreaterThan(3);
    expect(differs(was.shot, now.shot), 'the same picture came back')
        .toBeLessThan(0.02);
    // The point of the whole save path: the layout is beside the ELX, never
    // inside it.
    expect(now.elx).not.toContain('"x"');
    return was;
}

// 7 — a stranger sees no flow on this land; somebody who builds on it does.
async function othersLook(browser, world, testInfo, a, saved) {
    const b = await open(browser, world, 'B', testInfo);
    await signIn(b, 'ben@visp.example', 'Ben');
    await openAutomate(b);
    await expect(b.page.locator('#flows')).toBeVisible({ timeout: UI });
    await expect(b.page.locator('#flows .fl-list li[data-flow]')).toHaveCount(0);

    // Automate takes the window, so A leaves it before going to the land
    // panel — the plinth is behind the view while it is open.
    await panelApp(a, 'Build');
    await expect(a.page.locator('#flows')).toBeHidden({ timeout: UI });
    await panel(a, 'Your land');
    await a.page.locator('#panel li', { hasText: 'Bergli' })
        .locator('button.bare').first().click();
    const row = a.page.locator('#panel .row', { has: a.page.locator('input[type="email"]') });
    await row.locator('input[type="email"]').fill('cara@visp.example');
    await row.locator('select').selectOption('direct_edit');
    await row.getByRole('button', { name: 'Grant' }).click();
    await shows(a, 'cara@visp.example');

    const c = await open(browser, world, 'C', testInfo);
    await signIn(c, 'cara@visp.example', 'Cara');
    await openAutomate(c);
    await c.page.locator('#flows .fl-list li[data-flow] button.pick').click();
    await expect(c.page.locator('#flows .fl-top .name'))
        .toHaveText('lamp at dusk', { timeout: UI });
    expect(await c.page.evaluate(() => window.splatworld.flows.canvas().elx()),
        'C opens the same flow A saved').toBe(saved.elx);
    await c.close();
    await b.close();
}

// 8 — closing with something unsaved is a question with three answers.
async function closesDirty(a) {
    await openAutomate(a);
    await a.page.locator('#flows .fl-list li[data-flow] button.pick').click();
    await expect(a.page.locator('#flows .fl-top .name'))
        .toHaveText('lamp at dusk', { timeout: UI });
    await dragIn(a, 'strings contains', 'Contains', [0.45, 0.75]);
    await expect(a.page.locator('#flows .fl-dirty')).toBeVisible({ timeout: UI });
    await a.page.locator('#flows .fl-close').click();
    const box = a.page.locator('#flows .fl-ask');
    await expect(box).toContainText('unsaved changes', { timeout: UI });
    await expect(box.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(box.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(box.getByRole('button', { name: 'Stay' })).toBeVisible();
    await box.getByRole('button', { name: 'Discard' }).click();
    await expect(a.page.locator('#flows')).toBeHidden({ timeout: UI });
    // And the world is being drawn again.
    await expect(a.page.locator('#standing .coords')).toBeVisible({ timeout: UI });
}

test('story 16 — a flow is drawn on a land, saved, and found again',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in',
            () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('and takes a piece of land of their own', () => bergli(a));

        await test.step('1 — Automate says there is nothing on Bergli yet', async () => {
            await openAutomate(a);
            await expect(a.page.locator('#flows')).toBeVisible({ timeout: UI });
            await expect(a.page.locator('#flows .fl-empty'))
                .toContainText('No flows on Bergli yet', { timeout: UI });
        });

        await test.step('2 — a new flow, named, on an empty canvas', async () => {
            await a.page.locator('#flows .fl-new').click();
            await a.page.locator('#flows .fl-ask-name').fill('lamp at dusk');
            await a.page.getByRole('button', { name: 'Create' }).click();
            await expect(a.page.locator('#flows .fl-top .name'))
                .toHaveText('lamp at dusk', { timeout: UI });
            await expect(a.page.locator('#flows .fl-list li[data-flow]')).toHaveCount(1);
            expect(await names(a)).toEqual(WORLD);
        });

        await test.step('3 — blocks, ports and wires', () => draws(a));
        await test.step('and a constant on the input no wire reaches', () => constant(a));
        await test.step('4 — a name already used is refused, in a sentence', () => renames(a));
        await test.step('5 — undo twice, redo once', () => undoRedo(a));
        const saved = await test.step('6 — saved, and the same after a reload',
            () => savesAndReloads(a));
        await test.step('7 — B sees nothing of it; C, who builds there, does',
            () => othersLook(browser, world, testInfo, a, saved));
        await test.step('8 — closing with a change asks Save, Discard or Stay',
            () => closesDirty(a));

        // A window nobody closed is a WebGL context nobody gave back, and the
        // next story opens two of its own.
        await a.close();
    });
