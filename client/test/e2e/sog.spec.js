// WP2.6's acceptance: what a tab encodes, PlayCanvas reads — and encoding the
// same ply twice gives the same bytes. The ply here is a real merge of the
// published test tiles, so this is the whole z <= 14 path bar the publish.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';

const EMAIL = 'sog-e2e@splatworld.local';
const PW = 'sog-e2e-password';
const TILE = { z: 8, x: 133, y: 90 };
const BUDGET = 1200000;

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
    const kids = psql(`SELECT count(*) FROM tile
                       WHERE z = 10 AND published_version > 0
                         AND x BETWEEN ${TILE.x * 4} AND ${TILE.x * 4 + 3}
                         AND y BETWEEN ${TILE.y * 4} AND ${TILE.y * 4 + 3}`);
    if (kids === '0') test.skip(true, 'no published children — run `bash tools/test-tiles.sh`');
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

test('a merged ply becomes a sog the engine can read, twice over the same bytes',
    async ({ page }) => {
        const children = psql(`SELECT child_sogs(${TILE.z}, ${TILE.x}, ${TILE.y})::text`);
        const merge = readyAtom({
            ...TILE, op: 'merge', algo: 'merge-v1',
            inputs: { children: JSON.parse(children) },
            params: { ...TILE, voxel: 0.05, budget: BUDGET },
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);
        await page.locator('.work-toggle').check();
        await expect.poll(() => stateOf(merge), { timeout: 180000 }).toBe('verified');

        const sogs = [1, 2].map((run) => readyAtom({
            ...TILE, op: 'sog', algo: 'sog-v1',
            inputs: { ply: Number(merge) }, params: { budget: BUDGET, run },
        }));
        await expect.poll(() => sogs.map(stateOf).join('/'), { timeout: 180000 })
            .toBe('verified/verified');
        await page.locator('.work-toggle').uncheck();

        const shas = sogs.map((id) => psql(`SELECT output_sha256 FROM atom WHERE id = ${id}`));
        expect(shas[0]).toBe(shas[1], 'the same ply encodes to the same sog');

        const stats = resultOf(sogs[0]);
        expect(stats.splat_count).toBe(resultOf(merge).splat_count);
        expect(stats.tile).toEqual({ ...TILE, target_version: 1 });
        expect(stats.manifest.geometric_error_m).toBeGreaterThan(0);
        expect(Number.isFinite(stats.manifest.origin.lon)).toBe(true);

        // It is written where the tile will serve it from, not into the job's
        // scratch: db/0011_tilefiles.sql reserves that path for this atom.
        expect(stats.path).toBe(`/tiles/${TILE.z}/${TILE.x}/${TILE.y}/${shas[0]}.sog`);
        expect(existsSync(join(FILES_ROOT, stats.path.slice(1)))).toBe(true);

        const check = await readBack(page, svc.filesUrl + stats.path, shas[0]);
        expect(check.count).toBe(stats.splat_count);
        expect(check.decoded).toBe(stats.splat_count);
        expect(check.span).toBeGreaterThan(0);
        expect(check.loaded, 'PlayCanvas parsed the bundle').toBe(true);
        expect(check.placed, 'and a gsplat component accepted it').toBe(true);
        if (check.engineCount !== null) expect(check.engineCount).toBe(stats.splat_count);
        expect(errors).toEqual([]);
    });

// Decoded through our own reader, and then through the engine's.
function readBack(page, url, sha) {
    return page.evaluate(async ([href, name]) => {
        const { decodeSog, exactPixels } = await import('/lib/sogenc.js');
        const bytes = await fetch(href).then((r) => r.arrayBuffer());
        const canvas = (w, h) => new OffscreenCanvas(w, h);
        const { meta, splats } = await decodeSog(bytes, (b) => exactPixels(b, canvas));
        let span = 0;
        for (let i = 0; i < splats.count; i++) span = Math.max(span, Math.abs(splats.x[i]));

        const { pc, app } = window.splatworld;
        const asset = new pc.Asset('sog-probe', 'gsplat', { url: href, filename: `${name}.sog` });
        const loaded = await new Promise((resolve) => {
            asset.ready(() => resolve(true));
            asset.once('error', () => resolve(false));
            app.assets.add(asset);
            app.assets.load(asset);
        });
        const r = asset.resource;
        const engineCount = r?.numSplats ?? r?.gsplatData?.numSplats
            ?? r?.splatData?.numSplats ?? null;
        const entity = loaded ? new pc.Entity('probe') : null;
        if (entity) entity.addComponent('gsplat', { asset });
        return {
            count: meta.count, decoded: splats.count, span, loaded,
            engineCount, placed: Boolean(entity?.gsplat),
        };
    }, [url, sha]);
}
