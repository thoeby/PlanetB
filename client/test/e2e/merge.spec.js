// WP2.5's acceptance: merging the published children of a tile is
// deterministic, and the parent lands inside its budget. The children here are
// the tiles tools/test-tiles.sh publishes — two of the sixteen a z8 tile can
// have, which is also the missing-child path.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';
import { readPly } from '../../lib/ply.js';

const EMAIL = 'merge-e2e@splatworld.local';
const PW = 'merge-e2e-password';
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

test('two tabs merge the same children into the same parent, byte for byte',
    async ({ page }) => {
        const children = psql(`SELECT child_sogs(${TILE.z}, ${TILE.x}, ${TILE.y})::text`);
        const snapshot = psql(`SELECT world_snapshot(${TILE.z}, ${TILE.x}, ${TILE.y})`);
        const atoms = [1, 2].map((run) => readyAtom({
            ...TILE, op: 'merge', algo: 'merge-v1',
            inputs: { children: JSON.parse(children), snapshot },
            params: { ...TILE, voxel: 0.05, budget: BUDGET, run },
        }));
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);
        await page.locator('.work-toggle').check();
        await expect.poll(() => atoms.map(stateOf).join('/'), { timeout: 240000 })
            .toBe('verified/verified');
        await page.locator('.work-toggle').uncheck();

        const shas = atoms.map((id) => psql(`SELECT output_sha256 FROM atom WHERE id = ${id}`));
        expect(shas[0]).toBe(shas[1],
            'Invariant 7: the same merge is the same bytes, and hash verification says so');

        const stats = JSON.parse(psql(`SELECT result::text FROM atom WHERE id = ${atoms[0]}`));
        expect(stats.splat_count).toBeLessThanOrEqual(BUDGET);
        expect(stats.splat_count).toBeGreaterThan(0);
        expect(stats.from).toBeGreaterThan(0);
        const published = psql(`SELECT count(*) FROM tile
                                WHERE z = 10 AND published_version > 0
                                  AND x BETWEEN ${TILE.x * 4} AND ${TILE.x * 4 + 3}
                                  AND y BETWEEN ${TILE.y * 4} AND ${TILE.y * 4 + 3}`);
        expect(stats.used.length).toBe(Number(published),
            'every published child of the sixteen went in');
        expect(stats.used.length).toBeLessThan(16, 'and the rest are recorded as missing');
        expect(stats.voxel).toBeGreaterThan(0.05,
            'the voxel is widened to what the budget can hold');
        // The parent's frame is its own centre, at the height its children
        // stand on — zero for the synthetic test tiles, which sit on h = 0.
        expect(Number.isFinite(stats.origin.h)).toBe(true);
        expect(stats.origin.lon).toBeGreaterThan(7);
        expect(stats.origin.lon).toBeLessThan(9);

        // The second submission of a deterministic op is hash-verified by
        // submit_atom rather than re-checked by a verify atom (ARCHITECTURE §8).
        const checks = psql(`SELECT kind FROM verification
                             WHERE atom_id = ${atoms[1]} ORDER BY at`).split('\n');
        expect(checks, `verifications of atom ${atoms[1]}: ${checks}`)
            .toContain('structural');

        const ply = readPly(await fetch(svc.filesUrl + stats.path)
            .then((r) => r.arrayBuffer()));
        expect(ply.count).toBe(stats.splat_count);
        expect([...ply.x].every(Number.isFinite)).toBe(true);
        const reach = Math.max(...[...ply.x].map(Math.abs));
        expect(reach).toBeLessThan(200000, 'everything is inside the parent tile');
        expect(errors).toEqual([]);
    });
