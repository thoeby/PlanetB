// WP4.1's acceptance in a browser: a tab canonicalises a GLB, renders its
// thumbnail, PUTs both, registers the asset, and the catalog then shows it —
// with the SAN the database derived from the bytes.
//
// The two files are the same bench written by two different exporters, so the
// second upload has to land on the first one's entry rather than make a second.
// Their shared texture is random per run: a SAN is a function of the bytes, so
// a fixed fixture would collide with whatever an earlier run left in the
// database (the same trap tools/api-test.sh works around).

import { test, expect } from '@playwright/test';

import { startServices } from './services.js';
import { psql, revealPanels } from './worker.js';
import { encodePng } from '../../lib/png.js';
import { FIXTURES } from '../../../tools/make-asset-fixtures.mjs';

const EMAIL = 'catalog-e2e@splatworld.local';
const PW = 'catalog-e2e-password';

let svc = null;
let bench = null;

test.describe.configure({ timeout: 120000 });

function uniqueTexture(size = 16) {
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba.set([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 256), 255], i);
    }
    return encodePng(rgba, size, size);
}

test.beforeAll(async () => {
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    const texture = uniqueTexture();
    bench = { blender: FIXTURES.blender(texture), sketchfab: FIXTURES.sketchfab(texture) };
    svc = await startServices();
    if (!svc.ok) {
        svc.stop();
        test.skip(true, 'postgrest or nginx would not start');
    }
});

test.afterAll(() => svc?.stop());

// The catalog page has no worker, so it signs in through its own api module
// rather than through worker.js's helper.
async function open(page) {
    // The catalog is a tab of the world now (T4).
    await page.goto(`${svc.baseUrl}/play.html`);
    await revealPanels(page);
    await page.waitForFunction(() => window.splatworld?.catalog, null, { timeout: 30000 });
    await page.evaluate(async ([e, p]) => {
        const { api } = window.splatworld;
        await api.register(e, p).catch(() => {});
        await api.login(e, p);
    }, [EMAIL, PW]);
    await page.evaluate(() => window.splatworld.catalog.refresh());
}

async function upload(page, which, label) {
    await page.setInputFiles('#file', { name: `${which}.glb`,
        mimeType: 'model/gltf-binary', buffer: Buffer.from(bench[which]) });
    await expect(page.locator('#canon')).toContainText(/^S[A-Z2-7]{12} · 36 tris/);
    const san = (await page.locator('#canon').textContent()).split(' ')[0];
    await page.fill('#name', label);
    // Whatever this world calls its first category: the list comes from the
    // `product` kind's properties, which an admin edits (T3), so no name can be
    // written down here.
    await page.selectOption('#upload-category',
        await page.locator('#upload-category option').first().getAttribute('value'));
    await page.click('#publish');
    await expect(page.locator('#upload-status')).toHaveText(`published ${san}`);
    return san;
}

test('a tab canonicalises, renders and publishes an asset to the catalog',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await open(page);

        const san = await upload(page, 'blender', 'Park bench');
        expect(psql(`SELECT count(*) FROM asset WHERE san = '${san}'`)).toBe('1');

        // The thumbnail was rendered in the tab and is served from the store.
        const thumb = psql(`SELECT thumb_sha256 FROM asset WHERE san = '${san}'`);
        expect(thumb).toMatch(/^[0-9a-f]{64}$/);
        const res = await page.request.get(`${svc.filesUrl}/assets/${thumb}.webp`);
        expect(res.status()).toBe(200);
        expect(res.headers()['content-type']).toBe('image/webp');
        expect((await res.body()).length).toBeGreaterThan(64);

        await expect(page.locator('#results img[alt="Park bench"]')).toHaveCount(1);
        await expect(page.locator('#detail')).toContainText(san);

        // The same bench from another exporter is the same asset (Invariant 1).
        const twice = await upload(page, 'sketchfab', 'Bench again');
        expect(twice).toBe(san);
        expect(psql(`SELECT name FROM asset WHERE san = '${san}'`)).toBe('Park bench');
        await expect(page.locator('.near')).toHaveCount(1);

        expect(errors).toEqual([]);
    });
