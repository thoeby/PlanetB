// WP4.2's acceptance: place an asset from the catalog, the instance row exists,
// the tile it fell in goes dirty, "render now" compiles it, and the new version
// is published — with the asset in it.
//
// The last part is what makes build mode more than a row in a table: `assemble`
// loads the instance's canonical GLB and bakes its triangles into the tile, so
// the splats that publish are the world with the bench in it.

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLIENT, FILES_ROOT, seedGround, seedWorld } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, signIn, unpark } from './worker.js';
import { canonicalise } from '../../lib/canon.js';
import { encodePng } from '../../lib/png.js';
import { tileBbox, tileX, tileY } from '../../lib/tilemath.js';
import { FIXTURES } from '../../../tools/make-asset-fixtures.mjs';

const EMAIL = 'build-e2e@splatworld.local';
const PW = 'build-e2e-password';
const STRANGER = 'build-stranger@splatworld.local';
const LON = 8.0402;
const LAT = 47.3902;
// A neighbour of the tile pilot.spec compiles, so the two never share a job.
const TILE = { z: 14, x: tileX(LON, 14) - 1, y: tileY(LAT, 14) };

let svc = null;
let parked = [];
let asset = null;
let area = null;
let centre = null;

test.describe.configure({ timeout: 900000 });

// A bench with a texture nobody else will produce: a SAN is a function of the
// bytes, so a fixed fixture would land on whatever an earlier run registered
// (the same trap catalog.spec.js works around).
async function seedAsset() {
    const size = 16;
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba.set([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 256), 255], i);
    }
    const canon = await canonicalise(FIXTURES.blender(encodePng(rgba, size, size)));
    const path = join(FILES_ROOT, `assets/${canon.sha256}.glb`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canon.glb);
    psql(`INSERT INTO artifact (sha256, kind, bytes, algo_version)
          VALUES ('${canon.sha256}', 'glb', ${canon.glb.length}, 'canon-v1')
          ON CONFLICT (sha256) DO NOTHING`);
    psql(`INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                             tex_bytes, license, creator_id)
          VALUES ('${canon.san}', '${canon.sha256}', 1, 'Test bench', 'furniture',
                  '${JSON.stringify(canon.meta.bbox)}'::jsonb, ${canon.meta.tris},
                  ${canon.meta.tex_bytes}, 'cc0',
                  (SELECT id FROM auth.user WHERE email = '${EMAIL}'))
          ON CONFLICT (san) DO NOTHING`);
    return { ...canon, name: 'Test bench' };
}

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    seedGround(TILE.z, TILE.x, TILE.y);
    seedWorld(TILE.z, TILE.x, TILE.y);
    for (const email of [EMAIL, STRANGER]) {
        psql(`DO $$ DECLARE uid uuid;
              BEGIN
                  SELECT id INTO uid FROM auth.user WHERE email = '${email}';
                  IF uid IS NULL THEN uid := register('${email}', '${PW}'); END IF;
              END $$`);
    }
    // The area the test builds in: exactly the tile, at detail 14, so a
    // placement dirties this tile and its ancestors and nothing deeper.
    const b = tileBbox(TILE.z, TILE.x, TILE.y);
    centre = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
    // Idempotent: a second run must not stack another area over the same tile,
    // or area_at() starts answering with a pile of them.
    psql(`DELETE FROM instance WHERE area_id IN
              (SELECT id FROM area WHERE owner_id =
                   (SELECT id FROM auth.user WHERE email = '${EMAIL}'))`);
    psql(`DELETE FROM area WHERE owner_id =
              (SELECT id FROM auth.user WHERE email = '${EMAIL}')`);
    area = psql(`INSERT INTO area (geom, owner_id, detail)
                 VALUES (st_makeenvelope(${b.west}, ${b.south}, ${b.east}, ${b.north}, 4326),
                         (SELECT id FROM auth.user WHERE email = '${EMAIL}'), 14)
                 RETURNING id`);
    asset = await seedAsset();
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

const tileRow = (col) => psql(`SELECT coalesce(${col}::text, '0') FROM tile
                               WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}`);

// The work loop, pointed at one job: `focus` is what the Render pool panel uses
// when a player takes a tile out of it (client/js/work.js).
async function focusOnThisTile(page, tile) {
    const job = Number(psql(`SELECT j.id FROM job j JOIN tile t
        ON t.z = j.z AND t.x = j.x AND t.y = j.y
        WHERE j.z = ${tile.z} AND j.x = ${tile.x} AND j.y = ${tile.y}
          AND j.state = 'open' AND j.target_version = t.expected_version`));
    expect(job, 'a job for this tile').toBeGreaterThan(0);
    await page.evaluate(async (id) => {
        const work = await window.splatworld.work.ready();
        work.focus(id);
    }, job);
    return job;
}

test('a placed asset dirties its tile, renders into it, and stands on the ground',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);

        // Stand over the tile: the panel reports the ground under the camera,
        // because that is where a player builds.
        await page.evaluate(() => window.splatworld.setDriving(false));
        await page.evaluate(([at]) => {
            const { camera, origin } = window.splatworld;
            const p = origin.localOf({ lon: at.lon, lat: at.lat, h: at.h });
            camera.setPosition(p.x, p.y + 300, p.z);
            camera.setEulerAngles(-90, 0, 0);
        }, [{ ...centre, h: 400 }]);

        // Build mode takes the keyboard off the player and shows the catalog.
        await page.locator('.build-toggle').check();
        const found = await page.evaluate(() => window.splatworld.build.catalog(''));
        expect(found.map((a) => a.san)).toContain(asset.san);

        // ------------------------------------------------------- place
        // Placing is local until Save (SPEC §0.3 `placing`), so this saves.
        const placed = await page.evaluate(async ([areaId, san, at]) => {
            const { build } = window.splatworld;
            build.edits.place(areaId, san, at, { yaw: 0, scale: 1 });
            const [row] = (await build.edits.save()).rows;
            await build.sync();
            return row;
        }, [area, asset.san, { ...centre, h: 400 }]);
        expect(placed.id).toBeTruthy();
        expect(psql(`SELECT count(*) FROM instance WHERE id = '${placed.id}'`)).toBe('1');
        await page.evaluate(() => window.splatworld.build.refresh());

        // ------------------------------------------- the tile went dirty
        expect(tileRow('dirty')).toBe('true');
        const version = Number(tileRow('expected_version'));
        expect(version).toBeGreaterThan(0);
        const badge = page.locator('.build-tile', { hasText: `${TILE.z}/${TILE.x}/${TILE.y}` });
        await expect(badge).toContainText('dirty');

        // ------------------------------------------------- render now
        await badge.getByRole('button').click();
        await expect(badge.getByRole('button')).toContainText(/job \d+/);
        // This tile and nothing else. The pool has other work in it — since
        // db/0070_therebuildopensitself.sql a published child opens its
        // parent's rebuild — and a loop that takes whatever pays best is not
        // what this test is about (client/js/renderpool.js does the same for a
        // job somebody picked out of the pool).
        await focusOnThisTile(page, TILE);
        await page.locator('.work-toggle').check();
        // What lands is published: the decision comes before the render now
        // (SPEC §0.2, db/0069_approvalverbs.sql), and opening the job is what
        // this tab already did with the button above.
        await expect.poll(() => tileRow('published_version'), { timeout: 600000 })
            .toBe(String(version));
        await page.locator('.work-toggle').uncheck();

        // The bench is in the tile, not merely in a table: `assemble` loaded
        // its canonical GLB and baked it in.
        const stats = JSON.parse(psql(`SELECT a.result::text FROM atom a
                                       JOIN job j ON j.id = a.job_id
                                       WHERE a.op = 'assemble' AND j.z = ${TILE.z}
                                         AND j.x = ${TILE.x} AND j.y = ${TILE.y}
                                       ORDER BY a.id DESC LIMIT 1`));
        expect(stats.instances).toBe(1);

        expect(errors).toEqual([]);
    });

// The click path, end to end: a ray through the middle of the canvas, down onto
// the ground, and an insert where it lands.
//
// The ground is stubbed at a known height rather than streamed. The streamer
// refuses to refine into an unpublished child (tiles.js: a hole in the ground is
// worse than a coarse tile), so reaching z14 here would mean compiling the whole
// z6-to-z14 ladder — which is what client/test/e2e/pilot.spec.js already does.
// What is under test is the ray and the insert; the heightfield itself is
// covered by client/test/build.test.js and client/test/player.test.js.
test('a click places on the ground under the cursor, and undo takes it back',
    async ({ page }) => {
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);
        await page.evaluate(() => window.splatworld.setDriving(false));

        const GROUND = 12;
        const hit = await page.evaluate(async ([at, ground, san]) => {
            const { build, camera, origin, terrain } = window.splatworld;
            // Moving the camera 80 km makes the floating origin rebase on the
            // next frame, so nothing may be cached in the old frame: `here()`
            // is re-evaluated every time, and the stub answers in whatever
            // frame is current (origin.js).
            const here = () => origin.localOf({ lon: at.lon, lat: at.lat, h: at.h });
            const start = here();
            camera.setPosition(start.x, start.y + 200, start.z);
            camera.setEulerAngles(-90, 0, 0);
            await new Promise((r) => setTimeout(r, 500));
            const p = here();
            camera.setPosition(p.x, p.y + 200, p.z);
            camera.setEulerAngles(-90, 0, 0);
            // A flat world at a known height, in whatever frame is current.
            terrain.heightAt = () => here().y + ground;

            build.toggle(true);
            // toggle() starts a sync but does not wait for it; the area under
            // the camera is what decides whether a placement is attempted.
            await build.refresh();
            const rows = await build.catalog('');
            build.setBrush(rows.find((a) => a.san === san));
            if (!build.state.area) return { noArea: true };
            const box = document.getElementById('view').getBoundingClientRect();
            await build.place({ x: box.width / 2, y: box.height / 2 });
            const [row] = (await build.edits.save()).rows;
            if (!row) return null;
            build.state.selected = row;
            const now = here();
            const local = origin.localOf({ lon: row.lon, lat: row.lat, h: row.h });
            return { row, dy: local.y - (now.y + ground),
                dx: Math.hypot(local.x - now.x, local.z - now.z) };
        }, [{ ...centre, h: 400 }, GROUND, asset.san]);

        expect(hit, 'the ray found no ground to place on').not.toBeNull();
        expect(hit.noArea, 'the camera was not over a writable area').toBeUndefined();
        expect(psql(`SELECT count(*) FROM instance WHERE id = '${hit.row.id}'`)).toBe('1');
        expect(Math.abs(hit.dy), 'it did not land on the ground').toBeLessThan(0.1);
        expect(hit.dx, 'it did not land under the cursor').toBeLessThan(1);

        // The gizmo moves it a snapped quarter metre, and undo puts it back.
        const moved = await page.evaluate(() => window.splatworld.build.step(1));
        expect(moved.id).toBe(hit.row.id);
        const back = await page.evaluate(() => window.splatworld.build.undo());
        expect(Number(psql(`SELECT lon FROM instance WHERE id = '${hit.row.id}'`)))
            .toBeCloseTo(hit.row.lon, 9);
        expect(back).not.toBeNull();

        // Undoing the placement itself removes the row.
        await page.evaluate(() => window.splatworld.build.undo());
        expect(psql(`SELECT count(*) FROM instance WHERE id = '${hit.row.id}'`)).toBe('0');
    });

test('a stranger is refused by the database, not by the panel', async ({ page }) => {
    await openPage(page, svc.pageUrl);
    await signIn(page, STRANGER, PW);
    const seen = await page.evaluate(([at]) => window.splatworld.build.state
        && import('/js/build.js').then((m) => m.areasAt(at.lon, at.lat)), [centre]);
    expect(seen.every((a) => a.may_write === false)).toBe(true);

    // The panel would not offer it, so the test asks the API directly: the
    // policy is what refuses, not the client (Invariant 6).
    const refused = await page.evaluate(async ([areaId, san, at]) => {
        const { api } = window.splatworld;
        try {
            await api.insert('instance', [{ area_id: areaId, san, lon: at.lon, lat: at.lat,
                h: at.h, yaw: 0, pitch: 0, roll: 0, scale: 1 }]);
            return 'allowed';
        } catch (err) { return String(err.status ?? err.message); }
    }, [area, asset.san, { ...centre, h: 400 }]);
    expect(refused).not.toBe('allowed');
});
