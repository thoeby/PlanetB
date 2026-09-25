// What the TASKS-live.md stories do with things over and over: register a
// model with marked parts, go to Ben's field, put one down, pick it up again.
// Story 30's helpers, shared, for the stories from 40 on.

import { join } from 'node:path';

import { expect, looking, panel, UI } from './players.js';
import { REPO } from './world.js';
import { onSale, register, step } from './selling.js';

export const fixture = (name) => join(REPO, 'client/test/fixtures/assets', name);

export const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// ------------------------------------------------------------ registering

// C picks a model, names it, and marks each node with a role and its ports.
// `marks` is [{node, role, ports: [...]}]; `extra` runs before Register.
export async function registers(c, file, name, marks, extra = null) {
    await onSale(c);
    await c.page.locator('#upload-type').selectOption('model');
    await c.page.locator('#file').setInputFiles(fixture(file));
    await expect(c.page.locator('#canon')).toContainText('tris', { timeout: UI });
    await step(c, 'price');
    await c.page.locator('#name').fill(name);
    await step(c, 'parts');
    await expect(c.page.locator('#form-parts')).toBeVisible({ timeout: UI });
    for (const m of marks) {
        await c.page.locator(`#form-parts .mk-node:has-text("${m.node}")`).first().click();
        await expect(c.page.locator('#form-parts .mk-node.picked')).toHaveText(m.node);
        await c.page.locator('#form-parts .mk-role').selectOption(m.role);
        for (const port of m.ports ?? []) {
            await c.page.locator(`#form-parts .mk-port-${port}`).check();
            await expect(c.page.locator('#form-parts .mk-said'))
                .toContainText(port, { timeout: UI });
        }
    }
    if (extra) await extra(c);
    await register(c);
    const said = c.page.locator('#upload-status');
    await expect(said).toContainText('published S', { timeout: UI });
    return (await said.textContent()).match(/S[A-Z2-7]{12}/)[0];
}

// ------------------------------------------------------------- the placing

// Where story 41 puts the gate on Ben's field, north and east of where "Go
// there" stands you, in degrees.
export const GATE_AT = { north: 0.00054, east: 0.0004 };

export async function goesToTheLand(player) {
    await panel(player, 'Your land');
    await player.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return readCoords(await player.page.locator('#standing .coords').textContent());
}

// Somewhere on the land, `north` degrees up from where "Go there" put you.
export async function stands(player, world, here, north, east = 0) {
    await player.page.goto(`${world.pageUrl}#at=${(here.lat + north).toFixed(5)},`
        + `${(here.lon + east).toFixed(5)},0,0`);
    await looking(player);
    await expect(player.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return player.page.url();
}

export const thingsOn = (player) => player.page.evaluate(() =>
    [...window.splatworld.preview.rows.keys()]
        .filter((id) => !String(id).startsWith('placing:')));

export const sees = (player, id) => expect.poll(() => player.page.evaluate((want) =>
    Boolean(window.splatworld.preview.entities.get(want)), id), { timeout: UI });

// One product from the catalog, put down on bare ground, saved, and picked up
// again so the Ports section is about it. Returns the id the world gave it.
export async function plants(b, name) {
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
    await b.page.mouse.click(640, 520);
    await expect(b.page.locator('.build-ports-section')).toBeVisible({ timeout: UI });
    return (await thingsOn(b)).find((id) => !before.has(id));
}

// The world's own answer about the tiles over a spot, read beside what the
// page shows (a row read is allowed in addition, never instead: PLAYER-RUN.md).
export async function tilesUnder(world, lon, lat) {
    const res = await fetch(`${world.apiUrl}/rpc/tiles_at`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lon, lat, max_z: 18 }),
    });
    return res.ok ? res.json() : [];
}

// Where a thing stands, read off the page that drew it.
export const whereIs = (player, id) => player.page.evaluate((want) => {
    const row = window.splatworld.preview.rows.get(want);
    return row ? { lon: row.lon, lat: row.lat } : null;
}, id);

// ------------------------------------------------------------ in Automate

// Where a block's port is on the screen, from the numbers the canvas drew it
// with (story 16), and a wire drawn between two of them with the mouse.
async function portAt(player, name, input, slot) {
    return player.page.evaluate(([nodeName, isInput, index]) => {
        const canvas = window.splatworld.flows.canvas();
        const node = (canvas.graph._nodes ?? []).find((n) => n._irName === nodeName);
        if (!node) throw new Error(`no node called ${nodeName}`);
        const pos = node.getConnectionPos(isInput, index);
        const el = canvas.view.convertOffsetToCanvas([pos[0], pos[1]]);
        const r = canvas.view.canvas.getBoundingClientRect();
        return { x: r.left + el[0], y: r.top + el[1] };
    }, [name, input, slot]);
}

// The slot a port of a block is, by its name.
export const slotOf = (player, name, port, input) => player.page.evaluate(
    ([nodeName, portName, isInput]) => {
        const canvas = window.splatworld.flows.canvas();
        const node = (canvas.graph._nodes ?? []).find((n) => n._irName === nodeName);
        return (isInput ? node.inputs : node.outputs).findIndex((s) => s.name === portName);
    }, [name, port, input]);

export async function wire(player, from, to) {
    const out = await slotOf(player, from.node, from.port, false);
    const into = await slotOf(player, to.node, to.port, true);
    const a = await portAt(player, from.node, false, out);
    const b = await portAt(player, to.node, true, into);
    await player.page.mouse.move(a.x, a.y);
    await player.page.mouse.down();
    await player.page.mouse.move(b.x, b.y, { steps: 12 });
    await player.page.mouse.up();
}

// Whether a wire runs between two ports, read off the graph.
export const wired = (player, from, to) => player.page.evaluate(([f, t]) => {
    const g = window.splatworld.flows.canvas().graph;
    const a = (g._nodes ?? []).find((n) => n._irName === f.node);
    const b = (g._nodes ?? []).find((n) => n._irName === t.node);
    const slot = b.inputs.findIndex((s) => s.name === t.port);
    const link = g.links?.[b.inputs[slot]?.link] ?? g.links?.get?.(b.inputs[slot]?.link);
    return Boolean(link && link.origin_id === a.id
        && a.outputs[link.origin_slot]?.name === f.port);
}, [from, to]);
