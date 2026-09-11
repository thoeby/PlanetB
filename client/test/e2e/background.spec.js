// WP5.2's acceptance: a tab that offers to help render the world claims the
// cheap ops near the player, leaves the paid and expensive ones alone, and says
// how far the world has got — against the real database and the real panel.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'background-e2e@splatworld.local';
const PW = 'background-e2e-password';

let svc = null;
let parked = [];
let atoms = null;

test.describe.configure({ timeout: 180000 });

// Three atoms the loop cannot finish: each names itself as its input, so
// resolveInputs throws before anything is computed and the claim is all this
// test needs to see. Their ids ascend train < far < near, which is the order
// claim_atom would use if it had nothing else to go on (db/0005_state.sql).
function seed(at) {
    const y = tileY(at.lat, 14);
    const near = { z: 14, x: tileX(at.lon, 14) + 30, y };
    const far = { z: 14, x: tileX(at.lon, 14) + 3000, y };
    const made = {
        train: readyAtom({ ...near, op: 'train', algo: 'train-v1', params: {} }),
        far: readyAtom({ ...far, op: 'merge', algo: 'merge-v1', params: {} }),
        near: readyAtom({ ...near, op: 'merge', algo: 'merge-v1', params: {} }),
    };
    // The children are a fiction, but a merge with none at all is never handed
    // out (db/0035_mergeready.sql) and this test is about claim order.
    psql(`UPDATE atom SET inputs = jsonb_build_object('ply', id,
              'children', jsonb_build_array(repeat('c', 64)))
          WHERE id IN (${Object.values(made).join(',')})`);
    return made;
}

const stateOf = (id) => psql(`SELECT state FROM atom WHERE id = ${id}`);
const claimed = (id) => psql(`SELECT (claimed_at IS NOT NULL)::text FROM atom WHERE id = ${id}`);

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    svc = await startServices();
    if (!svc.ok) {
        svc.stop();
        test.skip(true, 'postgrest or nginx would not start');
    }
    parked = park();
});

test.afterAll(() => {
    if (atoms) {
        psql(`DELETE FROM atom WHERE id IN (${Object.values(atoms).join(',')})`);
    }
    unpark(parked);
    svc?.stop();
});

test('helping render the world claims the nearest cheap atom and nothing else',
    async ({ page }) => {
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);

        // Where the tab thinks it is, computed the way the panel computes it.
        const at = await page.evaluate(() => {
            const p = window.splatworld.camera.getPosition();
            const g = window.splatworld.origin.geodeticOf({ x: p.x, y: p.y, z: p.z });
            return { lon: g.lon, lat: g.lat };
        });
        atoms = seed(at);

        await page.locator('.work-world').check();
        await expect.poll(() => claimed(atoms.near), { timeout: 60000 }).toBe('true');

        // The far one is the same work, and the train atom has the lowest id of
        // the three: neither is what a background tab is for.
        expect(stateOf(atoms.far), 'the far tile waited').toBe('ready');
        expect(claimed(atoms.train), 'the train atom was never claimed').toBe('false');

        // What went out with the claim, as the database recorded it.
        const caps = JSON.parse(psql(`SELECT w.caps::text FROM worker w
                                      JOIN auth.user u ON u.id = w.user_id
                                      WHERE u.email = '${EMAIL}'`));
        expect(caps.ops).toEqual(['assemble', 'sample', 'merge', 'sog']);
        expect(Math.abs(caps.near.lon - at.lon)).toBeLessThan(0.001);

        await page.locator('.work-world').uncheck();
        await page.locator('.work-toggle').uncheck();
    });

test('and a tab not helping is still offered the work it was filtering out',
    async ({ page }) => {
        psql(`UPDATE atom SET state = 'ready', claimed_at = null, worker_id = null
              WHERE id IN (${Object.values(atoms).join(',')})`);
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);

        await page.locator('.work-toggle').check();
        await expect.poll(() => claimed(atoms.train), { timeout: 60000 }).toBe('true');
        await page.locator('.work-toggle').uncheck();
    });

test('the panel says how far the world has got, and so does an unauthenticated tab',
    async ({ page }) => {
        await openPage(page, svc.pageUrl);
        await expect(page.locator('.work-progress')).toContainText('tiles drawn',
            { timeout: 30000 });
        await expect(page.locator('.work-progress')).toContainText('z14');

        const res = await fetch(`${svc.apiUrl}/progress?select=z,tiles,published&order=z`);
        expect(res.status).toBe(200);
        const rows = await res.json();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => r.z === 14)).toBe(true);
    });
