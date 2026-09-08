// WP2.3's acceptance: a browser tab assembles a real z16 tile of the pilot
// region — the seeded Copernicus DEM, the seeded Sentinel-2 ortho and the OSM
// features in the database — in under a minute, and what it uploads is the tar
// the rest of the pipeline reads.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';
import { readTar } from '../../lib/tar.js';
import { readPly } from '../../lib/ply.js';
import { tileX, tileY } from '../../lib/tilemath.js';

const EMAIL = 'assemble-e2e@splatworld.local';
const PW = 'assemble-e2e-password';
const BUDGET = 600000;

// A z16 tile is 440 m across, so the fixture's buildings and its forest are in
// different ones: assemble both. The DEM and the ortho are seeded at z14 over
// the whole pilot, and geo.js falls back to the ancestor covering a tile it was
// not cut for.
const Z = 16;
const BUILT = { z: Z, x: tileX(8.0402, Z), y: tileY(47.3902, Z) };
const WOOD = { z: Z, x: tileX(8.0330, Z), y: tileY(47.3955, Z) };

let svc = null;
let parked = [];

test.describe.configure({ timeout: 180000 });

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
    // The world the atom compiles. seed-osm is idempotent, so this is a no-op
    // when `make api-test` has already run it.
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

function atomFor(t) {
    const snapshot = psql(`SELECT world_snapshot(${t.z}, ${t.x}, ${t.y})`);
    return {
        ...t,
        snapshot,
        id: readyAtom({
            ...t, op: 'assemble', algo: 'assemble-v1', inputs: { snapshot },
            params: { z: t.z, x: t.x, y: t.y, budget: BUDGET },
        }),
    };
}

const stateOf = (id) => psql(`SELECT state FROM atom WHERE id = ${id}`);

test('a tab assembles real z16 tiles of the pilot region in under a minute each',
    async ({ page }) => {
        const built = atomFor(BUILT);
        const wood = atomFor(WOOD);
        const atom = built.id;
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPage(page, svc.pageUrl);
        await signIn(page, EMAIL, PW);

        await page.locator('.work-toggle').check();
        await expect.poll(() => `${stateOf(built.id)}/${stateOf(wood.id)}`,
            { timeout: 150000 }).toBe('verified/verified');
        await page.locator('.work-toggle').uncheck();

        const kind = psql(`SELECT art.kind FROM atom a
                           JOIN artifact art ON art.sha256 = a.output_sha256
                           WHERE a.id = ${atom}`);
        expect(kind).toBe('init_ply');
        const stats = JSON.parse(psql(`SELECT result::text FROM atom WHERE id = ${atom}`));
        expect(stats.buildings).toBeGreaterThan(0);
        expect(stats.snapshot).toBe(built.snapshot);
        expect(stats.gpu_seconds,
            `${stats.gpu_seconds} s for ${built.x}/${built.y}`).toBeLessThan(60);

        const woodStats = JSON.parse(psql(
            `SELECT result::text FROM atom WHERE id = ${wood.id}`));
        expect(woodStats.trees, 'the forest was scattered').toBeGreaterThan(20);
        expect(woodStats.gpu_seconds).toBeLessThan(60);

        // The atom records where its output went: an artifact is written once,
        // so an identical rebuild points at the copy already in the store.
        const tar = readTar(await fetch(svc.filesUrl + stats.path)
            .then((r) => r.arrayBuffer()));
        expect([...tar.keys()]).toEqual(
            ['scene.json', 'mesh.bin', 'init.ply', 'height.r16', 'colliders.json']);
        const scene = JSON.parse(new TextDecoder().decode(tar.get('scene.json')));
        expect(scene.tile).toEqual({ z: BUILT.z, x: BUILT.x, y: BUILT.y });
        // The Aare valley around Aarau is 350-500 m up, and the ortho is real.
        expect(scene.origin.h).toBeGreaterThan(300);
        expect(scene.origin.h).toBeLessThan(700);
        expect(scene.materials.terrain).toBeTruthy();

        const ply = readPly(tar.get('init.ply'));
        expect(ply.count).toBe(Math.round(BUDGET * 0.3));
        // The ortho really was draped: finite colours, and more than one of them.
        expect([...ply.r].every(Number.isFinite)).toBe(true);
        expect([...ply.x].every(Number.isFinite)).toBe(true);
        const tones = new Set([...ply.g.slice(0, 20000)].map((v) => Math.round(v * 24)));
        expect(tones.size).toBeGreaterThan(4);
        expect(tar.get('height.r16').length).toBe(scene.height.size ** 2 * 2);
        const boxes = JSON.parse(new TextDecoder().decode(tar.get('colliders.json'))).boxes;
        expect(boxes.length).toBe(stats.buildings);
        expect(errors).toEqual([]);
    });
