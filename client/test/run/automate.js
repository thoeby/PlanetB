// What a player does in Automate, for the F10 stories (TASKS-flows.md, 32–38).
//
// The same gestures stories 16 and 29 make — drag a line off the palette, press
// a block's title bar, make a flow on a land — gathered once here rather than
// copied into five more files. Where a pixel is worked out from the canvas, it
// is worked out the way story 16 does: from the numbers the canvas drew with.

import { test, expect, looking, panel, panelApp, UI } from './players.js';

export const flows = (p) => p.page.locator('#flows');
export const said = (p) => p.page.locator('#flows .fl-said');
export const serverSelect = (p) => p.page.getByLabel('Server', { exact: true });

export async function openAutomate(p) {
    await panelApp(p, 'Automate');
    await expect(flows(p)).toBeVisible({ timeout: UI });
}

export async function chooseServer(p, name) {
    await serverSelect(p).selectOption({ label: name });
    await expect(p.page.locator('#flows .fl-srv .fl-dot'))
        .toHaveAttribute('data-state', 'up', { timeout: UI });
}

// Drag one line of the palette onto the canvas: press on the line, move, let
// go over the canvas.
export async function dragIn(p, search, label, at = [0.5, 0.45]) {
    const palette = p.page.locator('#flows .fl-palette');
    await palette.locator('input').fill(search);
    const line = palette.locator('li', { hasText: label }).first();
    await expect(line).toBeVisible({ timeout: UI });
    const from = await line.boundingBox();
    const box = await p.page.locator('#flows canvas.fl-canvas').boundingBox();
    await p.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await p.page.mouse.down();
    await p.page.mouse.move(box.x + box.width * at[0], box.y + box.height * at[1],
        { steps: 10 });
    await p.page.mouse.up();
}

export const nodeNames = (p) => p.page.evaluate(() =>
    (window.splatworld.flows.canvas().graph._nodes ?? []).map((n) => n._irName));

// A block selected the way a player selects it: a press on its title bar.
export async function selectBlock(p, name) {
    const at = await p.page.evaluate((nodeName) => {
        const canvas = window.splatworld.flows.canvas();
        const node = (canvas.graph._nodes ?? []).find((n) => n._irName === nodeName);
        if (!node) throw new Error(`no node called ${nodeName}`);
        const title = window.LiteGraph.NODE_TITLE_HEIGHT;
        const el = canvas.view.convertOffsetToCanvas(
            [node.pos[0] + node.size[0] / 2, node.pos[1] - title / 2]);
        const r = canvas.view.canvas.getBoundingClientRect();
        return { x: r.left + el[0], y: r.top + el[1] };
    }, name);
    await p.page.mouse.click(at.x, at.y);
}

// A new flow on a land, from the left column's New flow.
export async function newFlow(p, land, name) {
    await expect(p.page.locator('#flows .fl-list li.land'))
        .toContainText(land, { timeout: UI });
    await p.page.locator('#flows .fl-new').click();
    await p.page.locator('#flows .fl-land').selectOption({ label: land });
    await p.page.locator('#flows .fl-ask-name').fill(name);
    await p.page.getByRole('button', { name: 'Create' }).click();
    await expect(p.page.locator('#flows .fl-top .name')).toHaveText(name, { timeout: UI });
}

export async function saves(p) {
    await p.page.locator('#flows .fl-save').click();
    await expect(p.page.locator('#flows .fl-dirty')).toBeHidden({ timeout: UI });
}

export async function closeAutomate(p) {
    await test.step('closes Automate', async () => {
        await p.page.locator('#flows .fl-close').click();
        await expect(flows(p)).toBeHidden({ timeout: UI });
    });
}

// ------------------------------------------------------------- the lamp

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// Where a thing meets the ground on the screen — where a player clicks to
// pick it up (story 30 footOf).
export const footOf = (p, id) => p.page.evaluate((want) => {
    const { preview, camera, pc, app } = window.splatworld;
    const entity = preview.entities.get(want);
    if (!entity) return null;
    const s = camera.camera.worldToScreen(entity.getPosition(), new pc.Vec3());
    if (s.z <= 0) return null;
    const r = app.graphicsDevice.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
}, id);

// Where story 30 stood by the lamp it put on Ben's field: B goes to their land
// and walks the same few paces. Returns the address, which is how B tells
// anybody else where that is (SPEC §3.8).
export async function whereTheLampIs(b, world) {
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    const here = readCoords(await b.page.locator('#standing .coords').textContent());
    return `${world.pageUrl}#at=${(here.lat + 0.00036).toFixed(5)},${here.lon.toFixed(5)},0,0`;
}

// Standing there, the lamp is the thing of the product called Strassenlampe:
// the catalog says its SAN, and the thing of that SAN in view is the lamp.
export async function byTheLamp(p, url) {
    await p.page.goto(url);
    await looking(p);
    await expect(p.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    await panel(p, 'Place');
    const search = p.page.locator('.build-search');
    await search.fill('Strassenlampe');
    await search.dispatchEvent('change');
    const row = p.page.locator('.build-asset', { hasText: 'Strassenlampe' }).first();
    await expect(row).toBeVisible({ timeout: UI });
    const san = (await row.textContent()).match(/S[A-Z2-7]{12}/)[0];
    let lamp = null;
    await expect.poll(async () => {
        lamp = await p.page.evaluate((want) => [...window.splatworld.preview.rows.values()]
            .find((r) => r.san === want)?.id ?? null, san);
        return lamp;
    }, { timeout: UI }).not.toBeNull();
    return lamp;
}

// Build mode on, and a click where the lamp meets the ground: it is selected.
export async function selectsTheLamp(p, lamp) {
    await p.page.locator('.build-toggle').check();
    await expect.poll(() => footOf(p, lamp), { timeout: UI }).not.toBeNull();
    const at = await footOf(p, lamp);
    await p.page.mouse.click(at.x, at.y);
    await expect(p.page.locator('.build-flows-section')).toBeVisible({ timeout: UI });
}
