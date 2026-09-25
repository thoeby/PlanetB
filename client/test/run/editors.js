// What the editor stories (40 onwards, TASKS-editors.md) share: Ben back on
// his own land, and Blueprint opened over it.
//
// Ben has had a field since story 2 and shaped it in story 24, so every one of
// these starts from a land that is his and ground that is already moved.

import { expect, open, panel, signIn, UI } from './players.js';

export const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

// Ben, signed in, standing on his field.
export async function ben(browser, world, testInfo) {
    const b = await open(browser, world, 'B', testInfo);
    await signIn(b, 'ben@visp.example', 'Ben');
    await panel(b, 'Your land');
    await b.page.getByRole('button', { name: 'Go there' }).first().click();
    await expect(b.page.locator('#land')).toHaveText('Ben’s field', { timeout: UI });
    return b;
}

// Blueprint over his field, the way Shape opens it: the land chosen in the
// panel, the grid it is shaped into loaded, and the mode opened on both. The
// surface may be a stand-in that says which tool is in hand.
export async function blueprintOverHisLand(b, tool = 'pan') {
    await panel(b, 'Shape');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    const got = await b.page.evaluate(async (t) => {
        const sw = window.splatworld;
        const s = sw.sculpt.shaping();
        const ms = await sw.bpmode.open(s.area, s, { tool: () => window.__tool ?? t });
        return { ms, chunks: sw.blueprint.chunks.size, hidden: sw.streamer.hidden.size };
    }, tool);
    await expect(b.page.locator('#bp-side')).toBeVisible({ timeout: UI });
    return got;
}

// Blueprint's camera, as the page holds it.
export const cameraOf = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const p = sw.camera.getPosition();
    const c = sw.bpmode.cam.state;
    return { x: p.x, y: p.y, z: p.z, distance: c.distance, pitch: c.pitch, yaw: c.yaw,
        ortho: c.ortho, projection: sw.camera.camera.projection, on: sw.bpmode.cam.on };
});

// A drag with the left button, the way a person drags.
export async function drag(b, points, { button = 'left' } = {}) {
    await b.page.mouse.move(points[0].x, points[0].y);
    await b.page.mouse.down({ button });
    for (const p of points.slice(1)) await b.page.mouse.move(p.x, p.y, { steps: 3 });
    await b.page.mouse.up({ button });
}

// A picture of the whole window, kept beside the run's results: TASKS-editors
// asks for a screenshot next to each artboard once it is built.
export async function shot(b, testInfo, name) {
    const body = await b.page.screenshot();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(testInfo.outputPath(`${name}.png`), body);
    await testInfo.attach(name, { body, contentType: 'image/png' });
    return body;
}
