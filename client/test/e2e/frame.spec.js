// WP2.4's acceptance: a tab renders a range of a camera set off-screen, and two
// tabs given the same range agree. On one machine "agree" is byte equality,
// which is the strongest form of the PSNR bar the deliverable sets; a
// cross-GPU comparison needs two machines and is what that bar is really for.
//
// frame-v10 draws the baked mesh, so one machine renders the same bytes twice.
// The frames here are small: this is software rendering. The versions and the
// camera set are the ones the tab builds — a tab refuses an atom of a version
// it does not build (client/js/work.js), which is how this spec found out that
// it had been left behind.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, seedGround, seedWorld } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';
import { readTar } from '../../lib/tar.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'frame-e2e@splatworld.local';
const PW = 'frame-e2e-password';
const TILE = { z: 16, x: tileX(8.0402, 16), y: tileY(47.3902, 16) };
const FROM = 8;
const TO = 14;
const SIZE = 48;
const SAMPLES = 1;

let svc = null;
let parked = [];

test.describe.configure({ timeout: 300000 });

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    seedGround(TILE.z, TILE.x, TILE.y);
    seedWorld(TILE.z, TILE.x, TILE.y);
    svc = await startServices();
    if (!svc.ok) {
        svc.stop();
        test.skip(true, 'postgrest or nginx would not start');
    }
    parked = park();
});

test.afterAll(() => {
    unpark(parked);
    svc?.stop();
});

// Decodes one frame of a tar in the page and counts the tones it holds.
const inspect = (page, url, name) => page.evaluate(async ([u, n]) => {
    const { readTar: unpack } = await import('/lib/tar.js');
    const bytes = await fetch(u).then((r) => r.arrayBuffer());
    const webp = unpack(bytes).get(n);
    const bitmap = await createImageBitmap(new Blob([webp], { type: 'image/webp' }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    const { data } = c.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height);
    const seen = new Set();
    // Every seventh pixel, not every ninety-seventh: a 48 x 48 frame has
    // 2304 of them, and two dozen samples of a station's view of one hill
    // can all land on the same tone without the frame being blank.
    for (let i = 0; i < data.length; i += 4 * 7) seen.add(data[i] >> 3);
    return { w: bitmap.width, h: bitmap.height, tones: seen.size };
}, [url, name]);

const stateOf = (id) => psql(`SELECT state FROM atom WHERE id = ${id}`);
const resultOf = (id) => JSON.parse(psql(`SELECT result::text FROM atom WHERE id = ${id}`));

test('two tabs render the same range of a camera set to the same frames',
    async ({ page }) => {
        const snapshot = psql(`SELECT world_snapshot(${TILE.z}, ${TILE.x}, ${TILE.y})`);
        const assemble = readyAtom({
            ...TILE, op: 'assemble', algo: 'assemble-v5b', inputs: { snapshot },
            params: { ...TILE, budget: 600000 },
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);
        await page.locator('.work-toggle').check();
        await expect.poll(() => stateOf(assemble), { timeout: 120000 }).toBe('verified');

        // Two atoms, the same range, rendered one after the other by this tab.
        const frames = [1, 2].map((seed) => readyAtom({
            ...TILE, op: 'frame', algo: 'frame-v10',
            inputs: { assemble: Number(assemble), snapshot },
            params: { camera_set: 'z16-v2', from: FROM, to: TO, run: seed,
                size: SIZE, samples: SAMPLES },
        }));
        await expect.poll(() => frames.map(stateOf).join('/'), { timeout: 240000 })
            .toBe('verified/verified');
        await page.locator('.work-toggle').uncheck();

        const shas = frames.map((id) =>
            psql(`SELECT output_sha256 FROM atom WHERE id = ${id}`));
        expect(shas[0]).toBe(shas[1],
            'the same range rendered twice is the same bytes: psnr infinity');

        const stats = resultOf(frames[0]);
        expect(stats.frames).toBe(TO - FROM);
        expect(stats.camera_set).toBe('z16-v2');
        expect(stats.gpu_seconds).toBeLessThan(240);

        const tar = readTar(await fetch(svc.filesUrl + stats.path).then((r) => r.arrayBuffer()));
        const names = [...tar.keys()];
        expect(names).toEqual([
            'frame_0008.webp', 'frame_0009.webp', 'frame_0010.webp',
            'frame_0011.webp', 'frame_0012.webp', 'frame_0013.webp', 'transforms.json',
        ]);
        const t = JSON.parse(new TextDecoder().decode(tar.get('transforms.json')));
        expect(t.camera_model).toBe('OPENCV');
        expect(t.w).toBe(SIZE);
        expect(t.frames.map((f) => f.pose_id)).toEqual([8, 9, 10, 11, 12, 13]);
        expect(t.frames[0].transform_matrix[3]).toEqual([0, 0, 0, 1]);

        // The frames are real WebP images of the size asked for, and the range
        // is not blank. One station's view of a synthetic hill can legitimately
        // be two tones — z16-v2 looks straight down as well as from the side —
        // so the range as a whole is what has to have a picture in it.
        const shots = [];
        for (const name of ['frame_0008.webp', 'frame_0009.webp', 'frame_0010.webp']) {
            shots.push(await inspect(page, svc.filesUrl + stats.path, name));
        }
        for (const shot of shots) expect([shot.w, shot.h]).toEqual([SIZE, SIZE]);
        expect(Math.max(...shots.map((v) => v.tones))).toBeGreaterThan(3);
        expect(errors).toEqual([]);
    });
