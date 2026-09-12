// WP4.3's acceptance, in the browser: an `edit` grantee's placement becomes a
// proposal and changes nothing; the owner approves it, merges it, and only then
// does the world move and the tile go dirty. A `direct_edit` grantee skips the
// whole path, and a stranger is refused.
//
// The grant is made through the panel, by email, exactly as an owner would.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';
import { startServices } from './services.js';
import { openPage, psql, signIn } from './worker.js';

const OWNER = 'areas-owner@splatworld.local';
const EDITOR = 'areas-editor@splatworld.local';
const DIRECT = 'areas-direct@splatworld.local';
const PW = 'areas-e2e-password';
// Far from every other spec's world, so nothing here dirties their tiles.
const WEST = 21.0;
const SOUTH = 21.0;
const AT = { lon: 21.05, lat: 21.05, h: 300 };

let svc = null;
let area = null;
let san = null;

test.describe.configure({ timeout: 300000 });

const uid = (email) => psql(`SELECT id FROM auth.user WHERE email = '${email}'`);

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    for (const email of [OWNER, EDITOR, DIRECT]) {
        psql(`DO $$ DECLARE u uuid;
              BEGIN
                  SELECT id INTO u FROM auth.user WHERE email = '${email}';
                  IF u IS NULL THEN u := register('${email}', '${PW}'); END IF;
              END $$`);
    }
    // One area, owned by OWNER, rebuilt every run so the grants start empty.
    psql(`DELETE FROM approval WHERE proposal_id IN
              (SELECT id FROM proposal WHERE area_id IN
                   (SELECT id FROM area WHERE owner_id = '${uid(OWNER)}'))`);
    psql(`DELETE FROM proposal WHERE area_id IN
              (SELECT id FROM area WHERE owner_id = '${uid(OWNER)}')`);
    psql(`DELETE FROM instance WHERE area_id IN
              (SELECT id FROM area WHERE owner_id = '${uid(OWNER)}')`);
    psql(`DELETE FROM feature WHERE area_id IN
              (SELECT id FROM area WHERE owner_id = '${uid(OWNER)}')`);
    psql(`DELETE FROM area WHERE owner_id = '${uid(OWNER)}'`);
    area = psql(`INSERT INTO area (geom, owner_id, detail)
                 VALUES (st_makeenvelope(${WEST}, ${SOUTH}, ${WEST + 0.1}, ${SOUTH + 0.1},
                         4326), '${uid(OWNER)}', 14) RETURNING id`);
    // Any registered asset will do: what is under test is who may place it.
    san = psql('SELECT san FROM asset ORDER BY created_at LIMIT 1');
    if (!san) {
        psql(`INSERT INTO artifact (sha256, kind, bytes, algo_version)
              VALUES ('${'e'.repeat(64)}', 'glb', 1024, 'canon-v1')
              ON CONFLICT DO NOTHING`);
        san = psql(`INSERT INTO asset (san, sha256, canon_version, name, category, bbox,
                        tris, tex_bytes, license, creator_id)
                    VALUES (derive_san('${'e'.repeat(64)}'), '${'e'.repeat(64)}', 1,
                        'Areas fixture', 'prop', '{}'::jsonb, 12, 0, 'cc0',
                        '${uid(OWNER)}') RETURNING san`);
    }
    svc = await startServices();
    if (!svc.ok) {
        svc.stop();
        test.skip(true, 'postgrest or nginx would not start');
    }
});

test.afterAll(() => svc?.stop());

const proposals = () => Number(psql(
    `SELECT count(*) FROM proposal WHERE area_id = '${area}' AND state = 'open'`));
const instances = () => Number(psql(
    `SELECT count(*) FROM instance WHERE area_id = '${area}' AND deleted_at IS NULL`));

async function open(page, email) {
    await openPage(page, svc.pageUrl);
    await signIn(page, email, PW);
    await page.evaluate(() => window.splatworld.areas.refresh());
}

test('the owner grants by email, through the panel', async ({ page }) => {
    await open(page, OWNER);
    await expect(page.locator('.area-item')).toHaveCount(1);
    await page.fill('.area-email', EDITOR);
    await page.selectOption('.area-right', 'edit');
    await page.click('.area-give');
    await expect(page.locator('.area-status')).toHaveText('granted');
    expect(psql(`SELECT right_ FROM grant_ WHERE area_id = '${area}'
                 AND grantee_id = '${uid(EDITOR)}'`)).toBe('edit');

    await page.fill('.area-email', DIRECT);
    await page.selectOption('.area-right', 'direct_edit');
    await page.click('.area-give');
    await expect(page.locator('.area-grant')).toHaveCount(2);

    // An address with no account is refused by the database, not the panel.
    await page.fill('.area-email', 'nobody@splatworld.local');
    await page.click('.area-give');
    await expect(page.locator('.area-status')).toContainText('no account');
});

// What the tile under AT is waiting for. Land is ground, so the tile exists and
// is dirty before anybody places anything on it; what tells an edit from a
// proposal is whether this moves.
const versionAt = () => psql(`SELECT coalesce(max(expected_version), 0)::text FROM tile
    WHERE z = 14 AND x = tile_x(${AT.lon}, 14) AND y = tile_y(${AT.lat}, 14)`);

test("an edit grantee's placement becomes a proposal and changes nothing",
    async ({ page }) => {
        const before = instances();
        const versionBefore = versionAt();
        await open(page, EDITOR);

        const made = await page.evaluate(async ([areaId, s, at]) => {
            const { propose, placementDiff } = await import('/js/areas.js');
            return propose(areaId, placementDiff(s, at, { yaw: 0, scale: 1 }));
        }, [area, san, AT]);

        expect(made).toBeTruthy();
        expect(proposals()).toBe(1);
        expect(instances(), 'the world must not have moved').toBe(before);
        // The land's own tile is there and dirty from the moment it was claimed
        // (db/0047_landisground.sql). What a proposal must not do is move it.
        expect(versionAt(), 'a proposal moves no tile').toBe(versionBefore);

        // The proposer sees their own proposal, and cannot approve it.
        await page.evaluate(() => window.splatworld.areas.refresh());
        await expect(page.locator('.area-proposal')).toHaveCount(1);
        await expect(page.locator('.area-op')).toContainText('insert instance');
        await expect(page.locator('.area-approve')).toHaveCount(0);
    });

test('the owner approves and merges it, and the tile goes dirty', async ({ page }) => {
    const before = instances();
    const versionBefore = versionAt();
    await open(page, OWNER);
    await expect(page.locator('.area-proposal')).toHaveCount(1);

    await page.click('.area-approve');
    await expect(page.locator('.area-status')).toHaveText('approved: 1');
    expect(instances(), 'approving is not merging').toBe(before);

    await page.click('.area-merge');
    await expect(page.locator('.area-status')).toHaveText('merged 1 op(s)');
    expect(instances()).toBe(before + 1);
    expect(proposals(), 'the proposal is closed').toBe(0);
    expect(Number(versionAt()), 'merging moves the tile on').toBeGreaterThan(
        Number(versionBefore));
});

test('a direct_edit grantee writes the world without asking', async ({ page }) => {
    const before = instances();
    await open(page, DIRECT);
    const row = await page.evaluate(async ([areaId, s, at]) => {
        const { api } = window.splatworld;
        const [r] = await api.insert('instance', [{ area_id: areaId, san: s,
            lon: at.lon + 0.001, lat: at.lat, h: at.h, yaw: 0, pitch: 0, roll: 0, scale: 1 }],
        { select: 'id' });
        return r;
    }, [area, san, AT]);
    expect(row.id).toBeTruthy();
    expect(instances()).toBe(before + 1);
    expect(proposals(), 'and makes no proposal').toBe(0);
});

test('a stranger can neither write nor propose here', async ({ page }) => {
    await open(page, DIRECT);
    // DIRECT holds direct_edit on this area only; another area's is not theirs.
    const other = psql(`INSERT INTO area (geom, owner_id, detail)
        VALUES (st_makeenvelope(22.0, 22.0, 22.1, 22.1, 4326),
                '${uid(OWNER)}', 14) RETURNING id`);
    const refused = await page.evaluate(async ([areaId, s]) => {
        const { propose, placementDiff } = await import('/js/areas.js');
        try {
            await propose(areaId, placementDiff(s, { lon: 22.05, lat: 22.05, h: 0 }));
            return 'allowed';
        } catch (err) { return String(err.status ?? err.message); }
    }, [other, san]);
    expect(refused).not.toBe('allowed');
    psql(`DELETE FROM area WHERE id = '${other}'`);
});
