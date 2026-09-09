// The picture in docs/pilot.md: a whole z12 block of the pilot — its sixteen
// z14 children and the four rungs above them — compiled by one browser tab and
// then streamed by the viewer.
//
// Not part of the gate: sixteen baseline tiles are a few minutes of real work.
//
//     PILOT_BLOCK=1 npx playwright test client/test/e2e/pilot-block.spec.js

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT, REPO } from './serve.js';
import { startServices } from './services.js';
import { demSeeded, openPage, park, psql, signIn, unpark } from './worker.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'pilot-e2e@splatworld.local';
const PW = 'pilot-e2e-password';
const LON = 8.0402;
const LAT = 47.3902;
const BLOCK = { z: 12, x: tileX(LON, 12), y: tileY(LAT, 12) };
const LADDER = [BLOCK, ...[10, 8, 6].map((z) => ({ z, x: tileX(LON, z), y: tileY(LAT, z) }))];
let KIDS = [];

// Every z14 tile the world actually has inside this block. A tile with no row
// is ground nobody has drawn on, and the streamer does not treat it as a hole
// (client/js/tiles.js); a row that exists and is unpublished does block
// refinement, so these are exactly the tiles that have to be compiled.
function blockKids() {
    const rows = psql(`SELECT x || ' ' || y FROM tile
                       WHERE z = 14 AND x BETWEEN ${BLOCK.x * 4} AND ${BLOCK.x * 4 + 3}
                         AND y BETWEEN ${BLOCK.y * 4} AND ${BLOCK.y * 4 + 3}
                       ORDER BY x, y`);
    return rows ? rows.split('\n').map((r) => {
        const [x, y] = r.split(' ').map(Number);
        return { z: 14, x, y };
    }) : [];
}

let svc = null;
let parked = [];

test.describe.configure({ timeout: 3600000 });

test.beforeAll(async () => {
    if (!process.env.PILOT_BLOCK) test.skip(true, 'set PILOT_BLOCK=1 to compile a z12 block');
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    if (!demSeeded(FILES_ROOT, { z: 14, x: tileX(LON, 14), y: tileY(LAT, 14) })) {
        test.skip(true, 'the pilot dem is not seeded — run `bash tools/seed-dem.sh`');
    }
    psql(`UPDATE auth.user SET role = 'admin' WHERE email = '${EMAIL}'`);
    svc = await startServices();
    if (!svc.ok) { svc.stop(); test.skip(true, 'postgrest or nginx would not start'); }
    parked = park();
    KIDS = blockKids();
    if (!KIDS.length) test.skip(true, 'no z14 tiles in the block — seed the world first');
});

test.afterAll(() => {
    unpark(parked);
    svc?.stop();
});

const published = (t) => psql(`SELECT coalesce(published_version, 0)
                               FROM tile WHERE z = ${t.z} AND x = ${t.x} AND y = ${t.y}`);

test('a z12 block of the pilot, compiled by one tab and streamed', async ({ page }) => {
    await openPage(page, svc.pageUrl);
    await signIn(page, EMAIL, PW);
    await page.locator('.work-toggle').check();

    for (const t of KIDS) {
        await page.evaluate((tile) => window.splatworld.api.rpc('ensure_job', tile), t);
    }
    await expect.poll(() => KIDS.filter((t) => published(t) !== '0').length,
        { timeout: 3000000, intervals: [5000] }).toBe(KIDS.length);
    for (const t of LADDER) {
        await page.evaluate((tile) => window.splatworld.api.rpc('ensure_job', tile), t);
        await expect.poll(() => published(t), { timeout: 600000 }).not.toBe('0');
    }
    await page.locator('.work-toggle').uncheck();

    await openPage(page, svc.pageUrl);
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice,
        null, { timeout: 60000 });
    await page.evaluate(([lon, lat]) => {
        const { origin, camera, setDriving } = window.splatworld;
        setDriving(false);
        const p = origin.localOf({ lon, lat, h: 400 });
        camera.setPosition(p.x, p.y + 900, p.z);
        camera.setEulerAngles(-90, 0, 0);
    }, [LON, LAT]);
    await expect.poll(() => page.evaluate(
        () => [...window.splatworld.streamer.entries.values()]
            .filter((e) => e.entity).map((e) => `${e.row.z}/`).join('')),
    { timeout: 180000 }).toContain('14/');
    await page.waitForTimeout(4000);

    mkdirSync(join(REPO, 'docs'), { recursive: true });
    writeFileSync(join(REPO, 'docs/pilot.png'), Buffer.from(await frame(page), 'base64'));
    const seen = await page.evaluate(() => [...window.splatworld.streamer.entries.values()]
        .filter((e) => e.entity).map((e) => `${e.row.z}/${e.row.x}/${e.row.y}`));
    console.log(`# streaming ${seen.length} tiles: ${seen.join(' ')}`);
    expect(seen.some((k) => k.startsWith('14/'))).toBe(true);
});

// The canvas as a PNG. A WebGL drawing buffer is gone by the time a screenshot
// is taken — there is no preserveDrawingBuffer here — so the pixels are read
// inside the frame that drew them and encoded in the page.
function frame(page) {
    return page.evaluate(() => new Promise((resolve) => {
        const { app } = window.splatworld;
        let frames = 0;
        const tick = async () => {
            if (++frames < 20) return;
            app.off('postrender', tick);
            const c = document.getElementById('view');
            const gl = app.graphicsDevice.gl;
            const px = new Uint8Array(c.width * c.height * 4);
            gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const row = c.width * 4;
            const up = new Uint8ClampedArray(px.length);
            for (let y = 0; y < c.height; y++) {
                up.set(px.subarray((c.height - 1 - y) * row, (c.height - y) * row), y * row);
            }
            const off = new OffscreenCanvas(c.width, c.height);
            off.getContext('2d').putImageData(new ImageData(up, c.width, c.height), 0, 0);
            const blob = await off.convertToBlob({ type: 'image/png' });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < bytes.length; i += 8192) {
                s += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            resolve(btoa(s));
        };
        app.on('postrender', tick);
    }));
}
