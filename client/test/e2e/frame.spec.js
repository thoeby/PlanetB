// WP2.4's acceptance: a tab renders a range of a camera set off-screen, and two
// tabs given the same range agree. On one machine "agree" is byte equality,
// which is the strongest form of the PSNR bar the deliverable sets; a
// cross-GPU comparison needs two machines and is what that bar is really for.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';
import { readTar } from '../../lib/tar.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'frame-e2e@splatworld.local';
const PW = 'frame-e2e-password';
const TILE = { z: 16, x: tileX(8.0402, 16), y: tileY(47.3902, 16) };
const FROM = 8;
const TO = 14;

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
    if (!existsSync(join(FILES_ROOT, 'geo/dem'))) {
        test.skip(true, 'no seeded dem — run `bash tools/seed-dem.sh`');
    }
    if (psql("SELECT count(*) FROM feature WHERE props ? 'osm'") === '0') {
        execFileSync('bash', ['tools/seed-osm.sh'],
            { env: { ...process.env, OSM_FILE: 'infra/seed/pilot-fixture.osm' }, stdio: 'ignore' });
    }
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

const stateOf = (id) => psql(`SELECT state FROM atom WHERE id = ${id}`);
const resultOf = (id) => JSON.parse(psql(`SELECT result::text FROM atom WHERE id = ${id}`));

test('two tabs render the same range of a camera set to the same frames',
    async ({ page }) => {
        const snapshot = psql(`SELECT world_snapshot(${TILE.z}, ${TILE.x}, ${TILE.y})`);
        const assemble = readyAtom({
            ...TILE, op: 'assemble', algo: 'assemble-v1', inputs: { snapshot },
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
            ...TILE, op: 'frame', algo: 'frame-v1',
            inputs: { assemble: Number(assemble), snapshot },
            params: { camera_set: 'z16-v1', from: FROM, to: TO, run: seed },
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
        expect(stats.camera_set).toBe('z16-v1');
        expect(stats.gpu_seconds).toBeLessThan(240);

        const tar = readTar(await fetch(svc.filesUrl + stats.path).then((r) => r.arrayBuffer()));
        const names = [...tar.keys()];
        expect(names).toEqual([
            'frame_0008.webp', 'frame_0009.webp', 'frame_0010.webp',
            'frame_0011.webp', 'frame_0012.webp', 'frame_0013.webp', 'transforms.json',
        ]);
        const t = JSON.parse(new TextDecoder().decode(tar.get('transforms.json')));
        expect(t.camera_model).toBe('OPENCV');
        expect(t.w).toBe(1024);
        expect(t.frames.map((f) => f.pose_id)).toEqual([8, 9, 10, 11, 12, 13]);
        expect(t.frames[0].transform_matrix[3]).toEqual([0, 0, 0, 1]);

        // The frames are real 1024^2 WebP images, and they are not blank sky.
        const shot = await page.evaluate(async ([url, name]) => {
            const { readTar: unpack } = await import('/lib/tar.js');
            const bytes = await fetch(url).then((r) => r.arrayBuffer());
            const webp = unpack(bytes).get(name);
            const bitmap = await createImageBitmap(new Blob([webp], { type: 'image/webp' }));
            const c = new OffscreenCanvas(bitmap.width, bitmap.height);
            c.getContext('2d').drawImage(bitmap, 0, 0);
            const { data } = c.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height);
            const seen = new Set();
            for (let i = 0; i < data.length; i += 4 * 997) seen.add(data[i] >> 3);
            return { w: bitmap.width, h: bitmap.height, tones: seen.size };
        }, [svc.filesUrl + stats.path, 'frame_0008.webp']);
        expect([shot.w, shot.h]).toEqual([1024, 1024]);
        expect(shot.tones).toBeGreaterThan(3);
        expect(errors).toEqual([]);
    });
