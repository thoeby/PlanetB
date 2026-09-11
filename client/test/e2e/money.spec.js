// WP4.4's acceptance: a stranger renders my bounty and their balance
// increases, and I buy their asset and place it.
//
// The bounty is escrowed the moment it is set and released pro rata by
// reported GPU time when the tile publishes (db/0006_publish.sql), so this
// compiles a real z14 tile of the pilot in a second tab and watches the money
// move — out of the owner's wallet at once, into the worker's at publish.

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLIENT, FILES_ROOT, seedGround, seedWorld } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, revealPanels, signIn, unpark } from './worker.js';
import { canonicalise } from '../../lib/canon.js';
import { encodePng } from '../../lib/png.js';
import { tileBbox, tileX, tileY } from '../../lib/tilemath.js';
import { FIXTURES } from '../../../tools/make-asset-fixtures.mjs';

const OWNER = 'money-owner@splatworld.local';
const WORKER = 'money-worker@splatworld.local';
const PW = 'money-e2e-password';
const LON = 8.0402;
const LAT = 47.3902;
// Its own z14 tile: build.spec takes x-1 and pilot.spec takes x.
const TILE = { z: 14, x: tileX(LON, 14) - 2, y: tileY(LAT, 14) };
const BOUNTY = 25;

let svc = null;
let parked = [];
let area = null;
let asset = null;
let centre = null;

test.describe.configure({ timeout: 900000 });

const uid = (email) => psql(`SELECT id FROM auth.user WHERE email = '${email}'`);
const balance = (email) => Number(psql(
    `SELECT b.amount FROM balance b JOIN account a ON a.id = b.account_id
     WHERE a.owner_id = '${uid(email)}'`));

// A paid asset the owner sells and the worker buys, with a texture nobody else
// produces so the SAN is this run's alone.
async function seedAsset(creator) {
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba.set([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 256), 255], i);
    }
    const canon = await canonicalise(FIXTURES.blender(encodePng(rgba, 16, 16)));
    const path = join(FILES_ROOT, `assets/${canon.sha256}.glb`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canon.glb);
    psql(`INSERT INTO artifact (sha256, kind, bytes, algo_version)
          VALUES ('${canon.sha256}', 'glb', ${canon.glb.length}, 'canon-v1')
          ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
              tex_bytes, license, price, editions, creator_id)
          VALUES ('${canon.san}', '${canon.sha256}', 1, 'For sale', 'furniture',
              '${JSON.stringify(canon.meta.bbox)}'::jsonb, ${canon.meta.tris},
              ${canon.meta.tex_bytes}, 'limited', 7, 2, '${creator}')
          ON CONFLICT (san) DO NOTHING`);
    return canon;
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
    for (const email of [OWNER, WORKER]) {
        psql(`DO $$ DECLARE u uuid;
              BEGIN
                  SELECT id INTO u FROM auth.user WHERE email = '${email}';
                  IF u IS NULL THEN u := register('${email}', '${PW}'); END IF;
              END $$`);
    }
    // Money has to come from somewhere: the treasury is where it is minted.
    for (const email of [OWNER, WORKER]) {
        psql(`INSERT INTO ledger (debit, credit, amount, ref)
              SELECT treasury_account(), a.id, 200,
                     'seed:money:${Date.now()}:' || a.id
              FROM account a WHERE a.owner_id = '${uid(email)}'`);
    }
    const b = tileBbox(TILE.z, TILE.x, TILE.y);
    centre = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
    psql(`DELETE FROM instance WHERE area_id IN
              (SELECT id FROM area WHERE owner_id = '${uid(OWNER)}')`);
    psql(`DELETE FROM area WHERE owner_id = '${uid(OWNER)}'`);
    area = psql(`INSERT INTO area (geom, owner_id, detail)
                 VALUES (st_makeenvelope(${b.west}, ${b.south}, ${b.east}, ${b.north}, 4326),
                         '${uid(OWNER)}', 14) RETURNING id`);
    asset = await seedAsset(uid(OWNER));
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

const published = () => psql(`SELECT coalesce(published_version, 0)::text FROM tile
                              WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}`);
// What a renderer produces waits on the tile until a person approves it (T7).
const waiting = () => psql(`SELECT coalesce(candidate_version, 0)::text FROM tile
                            WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}`);

test('a stranger renders my bounty and is paid for it', async ({ page, browser }) => {
    const ownerBefore = balance(OWNER);
    const workerBefore = balance(WORKER);

    // ---- the owner dirties a tile and puts money on it
    await openPage(page, svc.pageUrl);
    await signIn(page, OWNER, PW);
    await page.evaluate(async ([areaId, san, at]) => {
        const { build } = window.splatworld;
        await build.edits.place(areaId, san, at, { yaw: 0, scale: 1 });
    }, [area, asset.san, { ...centre, h: 400 }]);

    const job = Number(psql(`SELECT ensure_job(${TILE.z}, ${TILE.x}, ${TILE.y})
                             FROM (SELECT set_config('request.jwt.claims',
                                 json_build_object('sub', '${uid(OWNER)}',
                                     'role', 'player')::text, true)) s`));
    expect(job).toBeGreaterThan(0);

    await page.evaluate(async ([j, amount]) => {
        const { setBounty } = await import('/js/wallet.js');
        await setBounty(j, amount);
    }, [job, BOUNTY]);

    // Escrowed at once: the money has left the owner and is nobody's yet.
    expect(balance(OWNER)).toBe(ownerBefore - BOUNTY);
    expect(Number(psql(`SELECT bounty FROM job WHERE id = ${job}`))).toBe(BOUNTY);
    await page.evaluate(() => window.splatworld.wallet.refresh());
    await expect(page.locator('.wallet-balance'))
        .toContainText(String(ownerBefore - BOUNTY));

    // ---- a stranger in another tab draws it
    const other = await browser.newPage();
    await openPage(other, svc.pageUrl);
    await signIn(other, WORKER, PW);
    await other.locator('.work-toggle').check();
    const target = String(psql(`SELECT expected_version::text FROM tile
              WHERE z = ${TILE.z} AND x = ${TILE.x} AND y = ${TILE.y}`));
    await expect.poll(waiting, { timeout: 600000 }).toBe(target);
    await other.locator('.work-toggle').uncheck();

    // ---- which nobody else sees until the owner of the ground says yes (T7)
    expect(published(), 'a stranger cannot publish onto my land').toBe('0');
    await page.evaluate(() => window.splatworld.hud.show('Permission'));
    await page.locator('.pm-refresh').click();
    await page.locator('.pm-yes').first().click();
    await expect.poll(published, { timeout: 30000 }).toBe(target);

    // ---- and is paid the whole bounty, because they did all of it
    expect(balance(WORKER), 'the worker was not paid').toBe(workerBefore + BOUNTY);
    expect(Number(psql(`SELECT count(*) FROM ledger WHERE ref LIKE 'pay:${job}:%'`)))
        .toBeGreaterThan(0);
    expect(balance(OWNER), 'and the owner paid exactly once').toBe(ownerBefore - BOUNTY);
    await other.close();
});

test('I buy their asset, and the edition count says so', async ({ page }) => {
    const before = balance(WORKER);
    // The catalog is a tab of the world now (T4).
    await page.goto(`${svc.baseUrl}/play.html`);
    await revealPanels(page);
    await page.waitForFunction(() => window.splatworld?.catalog, null, { timeout: 30000 });
    await page.evaluate(async ([e, p]) => {
        const { api } = window.splatworld;
        await api.login(e, p);
    }, [WORKER, PW]);
    await page.evaluate(() => window.splatworld.catalog.refresh());
    await page.evaluate((san) => window.splatworld.catalog.open(san), asset.san);

    const buy = page.locator('button.buy');
    await expect(buy).toHaveText('buy for 7');
    await buy.click();
    await expect(page.locator('button.buy')).toHaveText('you hold this');

    expect(balance(WORKER)).toBe(before - 7);
    expect(psql(`SELECT issued::text FROM asset WHERE san = '${asset.san}'`)).toBe('1');
    expect(psql(`SELECT count(*) FROM asset_right WHERE san = '${asset.san}'
                 AND holder_id = '${uid(WORKER)}'`)).toBe('1');

    // A second buy is a no-op, not a second charge (Invariant 5).
    const again = await page.evaluate(async (san) => {
        const { buyAsset } = await import('/js/wallet.js');
        return (await buyAsset(san)).san;
    }, asset.san);
    expect(again).toBe(asset.san);
    expect(balance(WORKER)).toBe(before - 7);
    expect(psql(`SELECT issued::text FROM asset WHERE san = '${asset.san}'`)).toBe('1');
});
