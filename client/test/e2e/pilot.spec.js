// WP2.8's acceptance: a browser tab compiles the pilot region from the real
// DEM, the real ortho and the real OSM features, all the way up the ladder —
// z14 assembled and sampled, then merged into z12, z10, z8 and z6 — and the
// viewer streams what it published.
//
// The gate compiles one z14 tile and its four ancestors, which is the whole
// mechanism; filling all 256 z14 tiles of the pilot is the same tab left
// running, and infra/seed/README.md says how long that takes.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT, seedGround, seedWorld } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, signIn, unpark } from './worker.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'pilot-e2e@splatworld.local';
const PW = 'pilot-e2e-password';
const LON = 8.0402;
const LAT = 47.3902;
const LADDER = [14, 12, 10, 8, 6].map((z) => ({ z, x: tileX(LON, z), y: tileY(LAT, z) }));

let svc = null;
let parked = [];

test.describe.configure({ timeout: 600000 });

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    seedGround(LADDER[0].z, LADDER[0].x, LADDER[0].y);
    seedWorld(LADDER[0].z, LADDER[0].x, LADDER[0].y);
    // The tab needs to be allowed to open jobs for tiles it does not own; the
    // seed's areas belong to the seed user. ensure_job lets an admin through.
    psql(`DO $$ DECLARE uid uuid;
          BEGIN
              SELECT id INTO uid FROM auth.user WHERE email = '${EMAIL}';
              IF uid IS NULL THEN uid := register('${EMAIL}', '${PW}'); END IF;
              UPDATE auth.user SET role = 'admin' WHERE id = uid;
          END $$`);
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

const rowOf = (t) => psql(`SELECT coalesce(published_version, 0) || '|'
                           || coalesce(manifest ->> 'splats', '0')
                           FROM tile WHERE z = ${t.z} AND x = ${t.x} AND y = ${t.y}`);

test('one tab compiles the pilot from z14 up to z6, and the viewer streams it',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);
        await page.locator('.work-toggle').check();

        // Each rung is opened once the one below it is published: a merge takes
        // its children's .sog, and publishing a tile is what dirties its parent.
        for (const t of LADDER) {
            const job = await page.evaluate(
                (tile) => window.splatworld.api.rpc('ensure_job', tile), t);
            expect(job, `a job for ${t.z}/${t.x}/${t.y}`).toBeTruthy();
            await expect.poll(() => rowOf(t).split('|')[0], { timeout: 300000 })
                .not.toBe('0');
        }
        await page.locator('.work-toggle').uncheck();

        // The whole ladder is published, and every tile says how many splats it
        // has. A parent thins on the way up: one z14 tile of the region is
        // compiled here, so by z6 that 1.7 km of ground is a few dozen clusters
        // of a 360 m voxel — which is what merge is for.
        const counts = [];
        for (const t of LADDER) {
            const [version, splats] = rowOf(t).split('|');
            expect(Number(version), `${t.z}/${t.x}/${t.y} published`).toBeGreaterThan(0);
            expect(Number(splats), `${t.z}/${t.x}/${t.y} has splats`)
                .toBeGreaterThan(t.z === 14 ? 100000 : 10);
            counts.push(Number(splats));
        }
        // The baseline tile is the fullest by far; the rungs above it thin out,
        // though not monotonically — a z6 tile of Switzerland has other
        // people's z8 children in it too.
        expect(counts[0], `splats up the ladder: ${counts}`)
            .toBeGreaterThan(Math.max(...counts.slice(1)) * 4);

        // The baseline tile carries the ground the player walks on and the
        // boxes they bump into, beside its .sog.
        const base = LADDER[0];
        const manifest = JSON.parse(psql(`SELECT manifest::text FROM tile
                                          WHERE z = ${base.z} AND x = ${base.x}
                                            AND y = ${base.y}`));
        expect(manifest.height.size).toBeGreaterThan(0);
        expect(manifest.colliders.count).toBeGreaterThanOrEqual(0);
        expect(existsSync(join(FILES_ROOT,
            `tiles/${base.z}/${base.x}/${base.y}/${manifest.height.sha256}.r16`))).toBe(true);
        expect(errors).toEqual([]);

        // And the viewer streams it: a fresh page, the camera over the pilot.
        // It stops at the coarsest rung whose children are not all published —
        // fifteen of this z12 tile's sixteen z14 children are still empty
        // ground, and refining into a hole would be worse than not refining
        // (client/js/tiles.js). docs/pilot.md is a full z12 block.
        const loaded = await stream(page, svc.pageUrl);
        expect(loaded.tiles, `loaded ${JSON.stringify(loaded)}`).toBeGreaterThan(0);
        expect(loaded.keys.some((k) => LADDER.some((t) => k === `${t.z}/${t.x}/${t.y}`)),
            `the pilot is on screen: ${loaded.keys}`).toBe(true);
    });

// A fresh load of play.html, flown to the pilot, with the streamer left to do
// its own work for a few seconds.
async function stream(page, pageUrl) {
    await openPage(page, pageUrl);
    await page.waitForFunction(() => window.splatworld?.app?.graphicsDevice,
        null, { timeout: 60000 });
    await page.evaluate(([lon, lat]) => {
        const { origin, camera, setDriving } = window.splatworld;
        setDriving(false);
        const p = origin.localOf({ lon, lat, h: 400 });
        camera.setPosition(p.x, p.y + 900, p.z + 700);
        camera.setEulerAngles(-40, 0, 0);
    }, [LON, LAT]);
    await page.waitForFunction(
        () => [...window.splatworld.streamer.entries.values()].some((e) => e.entity),
        null, { timeout: 60000 }).catch(() => {});
    return page.evaluate(() => {
        const live = [...window.splatworld.streamer.entries.values()].filter((e) => e.entity);
        return {
            tiles: live.length,
            splats: live.reduce((s, e) => s + (e.row.manifest?.splats ?? 0), 0),
            keys: live.map((e) => `${e.row.z}/${e.row.x}/${e.row.y}`),
        };
    });
}
