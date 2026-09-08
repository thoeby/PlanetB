// WP3's gate, at a size a software GPU can finish: one tab trains a real z16
// tile of the pilot region, three other tabs verify it, and the tile publishes
// itself without the trainer coming back.
//
// The DAG here is built by hand rather than by ensure_job, with the budgets,
// the iteration count and the frame size turned down — 600 000 splats over
// 5 000 iterations is what a real GPU is for (client/atoms/train.js). What is
// being tested is the machinery: that the trained ply becomes a .sog, that
// three independent tabs render it and agree, and that the third agreement is
// what moves the tile's pointer.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT, demSeeded, install } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, resetJob, signIn, unpark } from './worker.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const PREINSTALLED = '/opt/pw-browsers/chromium';
const LON = 8.0402;
const LAT = 47.3902;
const TILE = { z: 16, x: tileX(LON, 16), y: tileY(LAT, 16) };
const PARENT = { z: 14, x: tileX(LON, 14), y: tileY(LAT, 14) };
const BUDGET = 60000;
const FRAME_SIZE = 192;
const TRAIN_SIZE = 128;
const MIN_PSNR = 12;
const WHO = ['trainer', 'checker-a', 'checker-b', 'checker-c'];

test.use({
    launchOptions: {
        ...(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}),
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--disable-gpu-sandbox', '--enable-unsafe-webgpu'],
    },
});
test.describe.configure({ timeout: 900000 });

const json = (v) => JSON.stringify(v).replace(/'/g, "''");
const email = (who) => `train-${who}@splatworld.local`;
const PW = 'train-e2e-password';

let svc = null;
let parked = [];
let dag = null;

// The run's own seed. Rebuilding this DAG deletes the atoms that produced last
// run's artifacts, and an artifact whose atom is gone is registered but
// unfindable — client/js/inputs.js has nowhere left to ask where the bytes went.
// A fresh seed makes fresh bytes, so nothing collides with what is already in
// the store.
const SEED = Math.floor(Math.random() * 1e6);

function insert(job, op, algo, inputs, params, deps) {
    return Number(psql(
        `INSERT INTO atom (job_id, atom_hash, op, algo_version, inputs, params, deps,
                           seed, state)
         VALUES (${job}, encode(public.digest(random()::text, 'sha256'), 'hex'),
                 '${op}', '${algo}', '${json(inputs)}'::jsonb, '${json(params)}'::jsonb,
                 ARRAY[${deps.join(',')}]::bigint [], ${SEED},
                 '${deps.length ? 'waiting' : 'ready'}')
         RETURNING id`));
}

// assemble -> frame x3 -> train -> sog -> verify x3, the shape
// db/0017_verifydag.sql builds, with everything turned down.
function buildDag() {
    psql(`INSERT INTO tile (z, x, y, dirty, expected_version)
          VALUES (${TILE.z}, ${TILE.x}, ${TILE.y}, true, 1)
          ON CONFLICT (z, x, y) DO UPDATE SET dirty = true, expected_version = 1,
              published_version = 0, sog_sha256 = NULL, manifest = NULL`);
    const snapshot = psql(`SELECT world_snapshot(${TILE.z}, ${TILE.x}, ${TILE.y})`);
    const job = Number(psql(`INSERT INTO job (z, x, y, target_version, state)
                             VALUES (${TILE.z}, ${TILE.x}, ${TILE.y}, 1, 'open')
                             ON CONFLICT (z, x, y, target_version)
                             DO UPDATE SET state = 'open' RETURNING id`));
    resetJob(job);
    const asm = insert(job, 'assemble', 'assemble-v1', { snapshot },
        { ...TILE, budget: BUDGET }, []);
    const frames = [[0, 20], [20, 40], [40, 56]].map(([from, to]) =>
        insert(job, 'frame', 'frame-v1', { assemble: asm, snapshot },
            { camera_set: 'z16-v1', from, to, size: FRAME_SIZE }, [asm]));
    const trn = insert(job, 'train', 'train-v1', { assemble: asm, frames },
        { budget: BUDGET, iters: 80, camera_set: 'z16-v1', size: TRAIN_SIZE,
            needs_webgpu: true, min_vram_gb: 1 }, frames);
    const sog = insert(job, 'sog', 'sog-v1', { ply: trn }, { budget: BUDGET }, [trn]);
    const checks = [1, 2, 3].map((index) => insert(job, 'verify', 'verify-v1',
        { sog, frames },
        { index, min_psnr: MIN_PSNR, camera_set: 'z16-v1', size: TRAIN_SIZE,
            require_distinct_workers: true }, [sog]));
    return { job, asm, frames, trn, sog, checks };
}

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) { test.skip(true, `no database: ${err.message}`); }
    if (!demSeeded(PARENT.z, PARENT.x, PARENT.y)) {
        test.skip(true, 'the pilot dem is not seeded — run `bash tools/seed-dem.sh`');
    }
    // Judging somebody else's tile needs trust >= 0.6 (db/0019_trust.sql), which
    // a tab earns by having its own work accepted. These three are established
    // players who have never worked on this tile.
    for (const who of WHO) {
        psql(`DO $$ DECLARE uid uuid;
              BEGIN
                  SELECT id INTO uid FROM auth.user WHERE email = '${email(who)}';
                  IF uid IS NULL THEN uid := register('${email(who)}', '${PW}'); END IF;
                  IF NOT EXISTS (SELECT 1 FROM worker WHERE user_id = uid) THEN
                      INSERT INTO worker (user_id, caps, trust) VALUES (uid, '{}', 0.8);
                  END IF;
                  UPDATE worker SET trust = 0.8 WHERE user_id = uid;
              END $$`);
    }
    svc = await startServices();
    if (!svc.ok) { svc.stop(); test.skip(true, 'postgrest or nginx would not start'); }
    parked = park();
    dag = buildDag();
});

test.afterAll(() => {
    unpark(parked);
    svc?.stop();
});

const stateOf = (id) => psql(`SELECT state FROM atom WHERE id = ${id}`);
const resultOf = (id) => JSON.parse(psql(`SELECT coalesce(result::text, '{}')
                                          FROM atom WHERE id = ${id}`));

// One tab, signed in as `who`, working until `done()` says so. The work panel's
// own log is echoed as it changes: when this times out, what the tab was doing
// is the only thing worth knowing, and it is not in the database.
async function workAs(page, who, done, timeout) {
    await signIn(page, email(who), PW);
    await page.locator('.work-toggle').check();
    const until = Date.now() + timeout;
    let seen = '';
    while (Date.now() < until) {
        const now = await page.evaluate(
            () => document.querySelector('.work-log').textContent);
        if (now !== seen) {
            const fresh = now.split('\n').filter((l) => !seen.includes(l));
            seen = now;
            for (const line of fresh) console.log(`[${who}] ${line}`);
        }
        if (done()) {
            await page.locator('.work-toggle').uncheck();
            return;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    await page.locator('.work-toggle').uncheck();
    throw new Error(`${who} did not finish in ${timeout} ms; the panel said:\n${seen}`);
}

test('one tab trains a z16 tile and three others verify it into the world',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);

        await workAs(page, WHO[0], () => stateOf(dag.sog) === 'submitted', 780000);
        const trained = resultOf(dag.trn);
        expect(trained.backend, `trained on ${trained.backend}`).toBe('webgpu');
        expect(trained.splat_count).toBeGreaterThan(0);
        expect(trained.splat_count).toBeLessThanOrEqual(BUDGET);
        expect(trained.psnr, `${trained.psnr_before} dB -> ${trained.psnr} dB`)
            .toBeGreaterThan(trained.psnr_before);
        expect(trained.psnr).toBeGreaterThan(MIN_PSNR);

        // Three other tabs, none of which trained or encoded it.
        for (let i = 0; i < 3; i++) {
            const before = Number(psql(`SELECT count(*) FROM verification
                                        WHERE atom_id = ${dag.sog} AND kind = 'perceptual'`));
            await workAs(page, WHO[i + 1],
                () => Number(psql(`SELECT count(*) FROM verification
                                   WHERE atom_id = ${dag.sog} AND kind = 'perceptual'`))
                    > before, 300000);
        }

        const checks = JSON.parse(psql(`SELECT coalesce(json_agg(row_to_json(v)), '[]')
                                        FROM (SELECT passed, metrics -> 'psnr' AS psnr
                                              FROM verification
                                              WHERE atom_id = ${dag.sog}
                                                AND kind = 'perceptual') v`));
        expect(checks.length, JSON.stringify(checks)).toBe(3);
        expect(checks.every((c) => c.passed), JSON.stringify(checks)).toBe(true);
        expect(stateOf(dag.sog)).toBe('verified');

        const tile = JSON.parse(psql(`SELECT row_to_json(t)::text FROM
            (SELECT published_version, sog_sha256, manifest FROM tile
             WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}) t`));
        expect(Number(tile.published_version)).toBe(1);
        expect(existsSync(join(FILES_ROOT,
            `tiles/${TILE.z}/${TILE.x}/${TILE.y}/${tile.sog_sha256}.sog`))).toBe(true);
        expect(tile.manifest.splats).toBe(trained.splat_count);
        expect(errors, errors.join('\n')).toEqual([]);
    });

test('and the viewer streams the trained tile', async ({ page }) => {
    const published = psql(`SELECT published_version FROM tile
                            WHERE z = ${PARENT.z} AND x = ${PARENT.x} AND y = ${PARENT.y}`);
    test.skip(!Number(published),
        'the z14 parent is not published — the pilot spec compiles it');
    await install(page);
    await page.goto('/play.html');
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice, null,
        { timeout: 60000 });
    await page.evaluate(([lon, lat]) => {
        const { origin, camera, setDriving } = window.splatworld;
        setDriving(false);
        const p = origin.localOf({ lon, lat, h: 400 });
        camera.setPosition(p.x, p.y + 120, p.z);
        camera.setEulerAngles(-90, 0, 0);
    }, [LON, LAT]);
    const wanted = `${TILE.z}/${TILE.x}/${TILE.y}`;
    await expect.poll(() => page.evaluate(
        () => [...window.splatworld.streamer.entries.values()]
            .filter((e) => e.entity).map((e) => `${e.row.z}/${e.row.x}/${e.row.y}`),
    ), { timeout: 90000 }).toContain(wanted);
});
