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

// Blueprint over his field, the way a player opens it: Shape (EDT.6) opens
// the clay over the land chosen in its panel. A story about Blueprint itself
// rather than about shaping hands in a stand-in surface that only says which
// of the mode's own tools is in hand (the hand, the section).
export async function blueprintOverHisLand(b, tool = 'pan') {
    await panel(b, 'Shape');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    await b.page.waitForFunction(() => window.splatworld.blueprint.active
        && window.splatworld.bpmode.surface, null, { timeout: UI });
    const got = await b.page.evaluate((t) => {
        const sw = window.splatworld;
        if (t) sw.bpmode.state.surface = { tool: () => window.__tool ?? t };
        return { ms: sw.blueprint.openedMs, chunks: sw.blueprint.chunks.size,
            hidden: sw.streamer.hidden.size };
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

// Where on the screen a point of the ground is: a vertex inside his land near
// its middle, or one a few hundred metres past its eastern edge.
export const screenAt = (b, where) => b.page.evaluate((w) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const L = bp.L;
    let lon = L.lon0;
    let lat = L.lat0;
    if (w === 'inside') {
        let best = null;
        for (let k = 0; k < bp.inside.length; k++) {
            if (!bp.inside[k]) continue;
            const i = k % L.cols;
            const j = Math.floor(k / L.cols);
            const d = Math.hypot(i - L.cols / 2, j - L.rows / 2);
            if (!best || d < best.d) best = { d, i, j };
        }
        lon = L.bbox[0] + best.i * L.dLon;
        lat = L.bbox[3] - best.j * L.dLat;
        const p = bp.toScene(lon, lat, bp.heightAt(lon, lat));
        const s = sw.camera.camera.worldToScreen(p);
        return { x: s.x, y: s.y };
    }
    // Off the land a little way each side in turn, the first that is on the
    // open part of the screen rather than under a panel.
    const tries = [[0, -150 / 110540], [0, 150 / 110540], [-200 / L.mLon, 0],
        [200 / L.mLon, 0]];
    const s = bp.shaping;
    for (const [dLon, dLat] of tries) {
        const x = dLon ? (dLon < 0 ? L.bbox[0] : L.bbox[2]) + dLon : L.lon0;
        const y = dLat ? (dLat < 0 ? L.bbox[1] : L.bbox[3]) + dLat : L.lat0;
        if (s.inside(x, y)) continue;
        const q = sw.camera.camera.worldToScreen(bp.toScene(x, y, bp.heightAt(x, y)));
        if (q.x > 560 && q.x < 1000 && q.y > 170 && q.y < 680) return { x: q.x, y: q.y };
    }
    return null;
}, where);

// The screen point of a vertex of his land that is next to one that is not:
// the band just inside his boundary, the nearest such to the land's middle.
export const edgeOfHisLand = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const L = bp.L;
    let best = null;
    for (let j = 1; j < L.rows - 1; j++) {
        for (let i = 1; i < L.cols - 1; i++) {
            const k = j * L.cols + i;
            if (!bp.inside[k] || (bp.inside[k - 1] && bp.inside[k + 1])) continue;
            const d = Math.hypot(i - L.cols / 2, j - L.rows / 2);
            if (!best || d < best.d) best = { d, i, j };
        }
    }
    const lon = L.bbox[0] + best.i * L.dLon;
    const lat = L.bbox[3] - best.j * L.dLat;
    const s = sw.camera.camera.worldToScreen(bp.toScene(lon, lat, bp.heightAt(lon, lat)));
    return { x: s.x, y: s.y, lon, lat };
});

// How high the clay is under a screen point, and the grid there.
export const heightUnder = (b, at) => b.page.evaluate((p) => {
    const sw = window.splatworld;
    const s = sw.sculpt.shaping();
    return { clay: sw.blueprint.heightAt(p.lon, p.lat), grid: s.at(p.lon, p.lat) };
}, at);

// A point of his land as the clay has it, on the screen and on the ground.
export const pointOfHisLand = (b) => b.page.evaluate(() => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const L = bp.L;
    let best = null;
    for (let k = 0; k < bp.inside.length; k++) {
        if (!bp.inside[k]) continue;
        const i = k % L.cols;
        const j = Math.floor(k / L.cols);
        const d = Math.hypot(i - L.cols * 0.55, j - L.rows / 2);
        if (!best || d < best.d) best = { d, i, j };
    }
    const lon = L.bbox[0] + best.i * L.dLon;
    const lat = L.bbox[3] - best.j * L.dLat;
    const s = sw.camera.camera.worldToScreen(bp.toScene(lon, lat, bp.heightAt(lon, lat)));
    return { x: s.x, y: s.y, lon, lat };
});

// Shape open on his field, the clay drawn.
export async function shapeHisLand(b) {
    await b.page.mouse.move(900, 400);
    await b.page.keyboard.press('4');
    await expect(b.page.locator('.sc-land option')).not.toHaveCount(0, { timeout: UI });
    await b.page.waitForFunction(() => window.splatworld.blueprint.active, null, { timeout: UI });
}

// A point `east` and `north` metres from a ground point, on the screen too.
export const offsetOnScreen = (b, g, east, north) => b.page.evaluate(({ p, e, n }) => {
    const sw = window.splatworld;
    const bp = sw.blueprint;
    const lon = p.lon + e / (111320 * Math.cos(p.lat * Math.PI / 180));
    const lat = p.lat + n / 110540;
    const s = sw.camera.camera.worldToScreen(bp.toScene(lon, lat, bp.heightAt(lon, lat)));
    return { x: s.x, y: s.y, lon, lat };
}, { p: g, e: east, n: north });

// Lines open on his field, the clay drawn.
export async function linesOnHisLand(b) {
    await b.page.mouse.move(900, 400);
    await b.page.keyboard.press('5');
    await expect(b.page.locator('#panel header .title')).toHaveText('Lines');
    await b.page.waitForFunction(() => window.splatworld.blueprint.active
        && window.splatworld.lines.lines(), null, { timeout: UI });
    await expect(b.page.locator('.kp-kind').first()).toBeVisible({ timeout: UI });
}

// What the world holds for his land's lines.
export const linesInTheWorld = (b) => b.page.evaluate(async () => {
    const sw = window.splatworld;
    const area = sw.lines.lines().area;
    return sw.api.rpc('area_lines', { area: area.id });
});
