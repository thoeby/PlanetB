// WP3.3's acceptance: a published tile is tampered with, and the next owner to
// walk past notices.
//
// The tile here is built for real — assembled, framed and encoded by one tab —
// but not trained: the train atom is pointed at the assemble artifact, whose
// init.ply the encoder reads exactly as it would a trained one. What is being
// tested is the spot check, not the trainer (client/test/e2e/train.spec.js).

import { test, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT, seedGround, seedWorld } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, resetJob, signIn, unpark } from './worker.js';
import { tileBbox, tileX, tileY } from '../../lib/tilemath.js';

const LON = 8.0402;
const LAT = 47.3902;
// A sibling of the tile client/test/e2e/train.spec.js compiles, so the two
// specs never fight over the same job: same z14 parent, same seeded DEM.
const TILE = { z: 16, x: tileX(LON, 16) - 1, y: tileY(LAT, 16) };
const BUDGET = 60000;
const SIZE = 192;
const PW = 'spot-e2e-password';
const MAKER = 'spot-maker@splatworld.local';
const OWNER = 'spot-owner@splatworld.local';

test.describe.configure({ timeout: 600000 });

const json = (v) => JSON.stringify(v).replace(/'/g, "''");
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

function buildDag() {
    psql(`INSERT INTO tile (z, x, y, dirty, expected_version)
          VALUES (${TILE.z}, ${TILE.x}, ${TILE.y}, true, 1)
          ON CONFLICT (z, x, y) DO UPDATE SET dirty = true, expected_version = 1,
              published_version = 0, sog_sha256 = NULL, manifest = NULL, suspect = false`);
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
            { camera_set: 'z16-v1', from, to, size: SIZE }, [asm]));
    const trn = insert(job, 'train', 'train-v1', { assemble: asm, frames },
        { budget: BUDGET, camera_set: 'z16-v1' }, frames);
    const sog = insert(job, 'sog', 'sog-v1', { ply: trn }, { budget: BUDGET }, [trn]);
    [1, 2, 3].forEach((index) => insert(job, 'verify', 'verify-v1', { sog, frames },
        { index, min_psnr: 22, camera_set: 'z16-v1', size: SIZE }, [sog]));
    return { job, asm, frames, trn, sog };
}

// The tile's own frame is the trainer's; there is no trainer here, so the
// encoder is handed the assemble artifact under the train atom's name.
function fakeTraining() {
    const out = psql(`SELECT output_sha256 || '|' || (result ->> 'path')
                      FROM atom WHERE id = ${dag.asm}`).split('|');
    psql(`UPDATE atom SET state = 'claimed', claimed_at = now(), heartbeat_at = now(),
              worker_id = (SELECT w.id FROM worker w JOIN auth.user u ON u.id = w.user_id
                           WHERE u.email = '${MAKER}')
          WHERE id = ${dag.trn}`);
    psql(`UPDATE atom SET state = 'verified', output_sha256 = '${out[0]}',
              result = '${json({ path: out[1] })}'::jsonb WHERE id = ${dag.trn}`);
    psql(`SELECT advance_atoms(${dag.job})`);
}

// The tile, in the world, at the version it is waiting for.
//
// Whoever gets there first: the tab's own loop publishes what it verified, and
// when it has, publish_sog says false because there is nothing left to put
// forward. So this asks for the outcome rather than for the call — what this
// test needs is a published tile to tamper with, not a particular publisher.
function publishByHand() {
    psql(`UPDATE atom SET state = 'verified' WHERE id = ${dag.sog}`);
    // What the tile is waiting for now: publish_sog compares the job's target
    // against tile.expected_version (Invariant 3), and anything that touched
    // this ground while the atoms ran — claiming land is an edit too
    // (db/0047) — moves it.
    psql(`UPDATE job SET target_version = (SELECT expected_version FROM tile
              WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y})
          WHERE id = ${dag.job} AND state <> 'done'`);
    psql(`SELECT publish_sog(a, (SELECT user_id FROM worker WHERE id = a.worker_id),
                             a.result -> 'manifest')
          FROM atom a WHERE a.id = ${dag.sog}`);
    // It is a candidate until the owner of the ground says yes (T7). This test
    // is about what happens to a tile after it is in the world, so the owner
    // says yes here rather than through the panel.
    psql(`DO $$ BEGIN
              PERFORM set_config('request.jwt.claims', json_build_object(
                  'sub', (SELECT id FROM auth.user WHERE email = '${OWNER}'),
                  'role', 'player')::text, true);
              PERFORM approve_tile(${TILE.z}, ${TILE.x}, ${TILE.y});
          END $$;`);
    return psql(`SELECT (published_version = expected_version
                         AND sog_sha256 IS NOT NULL)::text FROM tile
                 WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}`);
}

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) { test.skip(true, `no database: ${err.message}`); }
    seedGround(TILE.z, TILE.x, TILE.y);
    seedWorld(TILE.z, TILE.x, TILE.y);
    for (const who of [MAKER, OWNER]) {
        psql(`DO $$ DECLARE uid uuid;
              BEGIN
                  SELECT id INTO uid FROM auth.user WHERE email = '${who}';
                  IF uid IS NULL THEN uid := register('${who}', '${PW}'); END IF;
              END $$`);
    }
    // The ground the owner polices: an area over the tile, theirs.
    const b = tileBbox(TILE.z, TILE.x, TILE.y);
    psql(`DELETE FROM area WHERE owner_id = (SELECT id FROM auth.user
                                             WHERE email = '${OWNER}')`);
    psql(`INSERT INTO area (geom, owner_id, detail)
          VALUES (st_makeenvelope(${b.west}, ${b.south}, ${b.east}, ${b.north}, 4326),
                  (SELECT id FROM auth.user WHERE email = '${OWNER}'), 16)`);
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

async function workAs(page, who, done, timeout) {
    await signIn(page, who, PW);
    await page.locator('.work-toggle').check();
    await expect.poll(done, { timeout, intervals: [2000] }).toBe(true);
    await page.locator('.work-toggle').uncheck();
}

const sweep = (page, row) => page.evaluate(
    (t) => window.splatworld.spot.sweep([t]), row);

// SpotChecker.sweep swallows what one tile's check threw, because a courtesy
// that stops the tab is not a courtesy. The test wants the exception.
const check = (page, row) => page.evaluate(
    (t) => window.splatworld.spot.check(t).catch(
        (e) => ({ err: String(e.stack ?? e).split('\n').slice(0, 3).join(' | ') })), row);

test('a tampered tile is caught by the next owner to look at it',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);

        await workAs(page, MAKER,
            () => dag.frames.every((f) => stateOf(f) === 'verified'), 300000);
        fakeTraining();
        // 'submitted' is a state the sog passes through, not one it rests in:
        // submit_atom verifies it in the same breath, so a poll that waits for
        // exactly 'submitted' waits out its whole timeout on a tab quick enough
        // to do both between two samples. What this step is waiting for is the
        // sog to have been made and handed in.
        await workAs(page, MAKER,
            () => ['submitted', 'verified'].includes(stateOf(dag.sog)), 300000);
        // Each pass is a no-op once the tile is in the world, so this waits
        // for whichever publisher gets there first rather than racing the tab.
        await expect.poll(publishByHand, { timeout: 60000, intervals: [1000] })
            .toBe('true');

        const row = JSON.parse(psql(`SELECT row_to_json(t)::text FROM
            (SELECT z, x, y, sog_sha256, suspect FROM tile
             WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}) t`));
        expect(row.suspect).toBe(false);

        // The publisher is the wrong person to ask, area or no area.
        await signIn(page, MAKER, PW);
        expect(await sweep(page, row)).toBe(null);

        // A different tile, served under this one's name: the same gaussians
        // moved eighty metres sideways, re-encoded into a perfectly valid .sog.
        // Nothing in the store re-hashes what it holds (db/0008_files.sql's v1
        // caveat), which is exactly the hole a spot check is for.
        const path = `tiles/${row.z}/${row.x}/${row.y}/${row.sog_sha256}.sog`;
        const moved = await page.evaluate(async ([url, shift]) => {
            const { decodeSog, encodeSog } = await import('/lib/sogenc.js');
            const { decodeImage } = await import('/lib/geo.js');
            const canvas = (w, h) => new OffscreenCanvas(w, h);
            const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
            const { splats } = await decodeSog(bytes, (b) => decodeImage(b, canvas));
            for (let i = 0; i < splats.count; i++) splats.x[i] += shift;
            return [...(await encodeSog(splats, canvas)).bytes];
        }, [`${svc.filesUrl}/${path}`, 80]);
        expect(moved.length, 'a re-encoded .sog to swap in').toBeGreaterThan(0);
        writeFileSync(join(FILES_ROOT, path), Buffer.from(moved));

        await signIn(page, OWNER, PW);
        const due = await page.evaluate(
            (t) => window.splatworld.api.rpc('spot_due', t)
                .then((r) => r, (e) => ({ err: String(e.message ?? e) })),
            { z: row.z, x: row.x, y: row.y });
        expect(due, `spot_due said ${JSON.stringify(due)}`).toHaveLength(1);
        const out = await check(page, row);
        expect(out?.err, 'the check itself').toBe(undefined);
        expect(out, 'the owner was given something to check').not.toBe(null);
        expect(out.kind).toBe('perceptual');
        expect(out.passed).toBe(false);
        expect(out.state).toBe('suspect');
        expect(psql(`SELECT suspect FROM tile WHERE z = ${TILE.z} AND x = ${TILE.x}
                       AND y = ${TILE.y}`)).toBe('t');
        expect(Number(psql(`SELECT count(*) FROM verification
                            WHERE atom_id = ${dag.sog} AND kind = 'perceptual'
                              AND NOT passed AND (metrics ->> 'spot')::boolean`))).toBe(1);
        expect(errors, errors.join('\n')).toEqual([]);
    });
