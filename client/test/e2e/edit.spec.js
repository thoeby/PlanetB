// WP5.3's acceptance, in the browser: a forest drawn with the mouse on the
// editor's map becomes a feature row, and every tile that forest covers goes
// dirty. The clicks are real clicks on the OpenLayers viewport — what is under
// test is the map, not a function call that pretends to be one.
//
// The other two tests are the same drawing done by the two other kinds of
// account: an `edit` grantee, whose forest becomes a proposal and changes
// nothing, and a stranger, who is refused by the panel and then by the
// database (Invariant 6).

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';
import { startServices } from './services.js';
import { psql } from './worker.js';

const OWNER = 'edit-owner@splatworld.local';
const PROPOSER = 'edit-proposer@splatworld.local';
const STRANGER = 'edit-stranger@splatworld.local';
const PW = 'edit-e2e-password';
// This spec's own patch of world: areas.spec draws at 21°E/21°N, build and
// money work the pilot at 8°E/47.4°N. Nothing else goes near 31°E/31°N.
const WEST = 31.0;
const SOUTH = 31.0;

let svc = null;
let area = null;

test.describe.configure({ timeout: 300000 });

const uid = (email) => psql(`SELECT id FROM auth.user WHERE email = '${email}'`);
const features = () => Number(psql(
    `SELECT count(*) FROM feature WHERE area_id = '${area}' AND deleted_at IS NULL`));
const proposals = () => Number(psql(
    `SELECT count(*) FROM proposal WHERE area_id = '${area}' AND state = 'open'`));

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/ol/ol.js'))) {
        test.skip(true, 'no vendored OpenLayers — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
    }
    for (const email of [OWNER, PROPOSER, STRANGER]) {
        psql(`DO $$ DECLARE u uuid;
              BEGIN
                  SELECT id INTO u FROM auth.user WHERE email = '${email}';
                  IF u IS NULL THEN u := register('${email}', '${PW}'); END IF;
              END $$`);
    }
    // One area, rebuilt every run, so the counts below start at zero.
    const mine = `(SELECT id FROM area WHERE owner_id = '${uid(OWNER)}')`;
    psql(`DELETE FROM approval WHERE proposal_id IN
              (SELECT id FROM proposal WHERE area_id IN ${mine})`);
    psql(`DELETE FROM proposal WHERE area_id IN ${mine}`);
    psql(`DELETE FROM feature WHERE area_id IN ${mine}`);
    psql(`DELETE FROM grant_ WHERE area_id IN ${mine}`);
    psql(`DELETE FROM area WHERE owner_id = '${uid(OWNER)}'`);
    area = psql(`INSERT INTO area (geom, owner_id, detail)
                 VALUES (st_makeenvelope(${WEST}, ${SOUTH}, ${WEST + 0.1}, ${SOUTH + 0.1},
                         4326), '${uid(OWNER)}', 14) RETURNING id`);
    // grant_ moves only under set_grant(), which wants the owner's session;
    // psql is the owner of the database, not of the area.
    psql(`INSERT INTO grant_ (area_id, grantee_id, right_)
          VALUES ('${area}', '${uid(PROPOSER)}', 'edit')`);
    // An earlier run left its tiles dirty. What is under test is that this
    // run's drawing dirties them, so they start clean.
    psql(`UPDATE tile SET dirty = false
          WHERE st_intersects(tile_bbox(z, x, y), (SELECT geom FROM area WHERE id = '${area}'))`);

    svc = await startServices();
    if (!svc.ok) {
        svc.stop();
        test.skip(true, 'postgrest or nginx would not start');
    }
});

test.afterAll(() => svc?.stop());

// Only OpenLayers is intercepted, exactly as worker.js intercepts the engine:
// the API, the file store and the page are real servers on localhost.
async function open(page, email) {
    await page.route('https://cdn.jsdelivr.net/**', (route) => {
        const css = route.request().url().endsWith('.css');
        route.fulfill({
            contentType: css ? 'text/css' : 'text/javascript',
            body: readFileSync(join(CLIENT, 'vendor/ol', css ? 'ol.css' : 'ol.js')),
        });
    });
    await page.goto(`${svc.baseUrl}/edit.html`);
    await page.waitForFunction(() => window.splatworld?.edit, null, { timeout: 60000 });
    await page.evaluate(async ([e, p]) => {
        const { api } = window.splatworld;
        await api.register(e, p).catch(() => {});
        await api.login(e, p);
    }, [email, PW]);
    // The panel follows the login form; a test that signs in through api.js
    // has to say so itself (catalog.spec.js does the same).
    await page.evaluate(() => window.splatworld.edit.refresh());
}

// Three clicks and a fourth on the first vertex, which is how a polygon is
// closed. Finishing with a double-click would work too, but the second half of
// it reaches DoubleClickZoom once Draw has stopped listening, and the map
// would zoom out from under the assertions.
async function drawTriangle(page, dx = 0) {
    const box = await page.locator('#map').boundingBox();
    const cx = Math.round(box.x + box.width / 2) + dx;
    const cy = Math.round(box.y + box.height / 2);
    const ring = [[cx - 70, cy - 50], [cx + 70, cy - 50], [cx, cy + 60]];
    for (const [x, y] of ring) await page.mouse.click(x, y);
    await page.mouse.click(ring[0][0], ring[0][1]);
}

test('a forest drawn on the map becomes a feature row and dirties its tiles',
    async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await open(page, OWNER);

        await expect(page.locator('.edit-area')).toHaveCount(1);
        await expect(page.locator('.edit-perm')).toHaveText('you may draw here');
        expect(features(), 'the area starts empty').toBe(0);

        await page.selectOption('.edit-kind', 'forest');
        await page.click('.edit-draw');
        await drawTriangle(page);
        await expect(page.locator('.edit-status')).toContainText('drawn');

        // The prop form is the kind's own: what `assemble` reads off a forest.
        await page.selectOption('.edit-field[data-key="leaf_type"]', 'broadleaved');
        await page.click('.edit-save');
        await expect(page.locator('.edit-status')).toHaveText(/^saved /);

        const id = psql(`SELECT id FROM feature
                         WHERE area_id = '${area}' AND deleted_at IS NULL`);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(psql(`SELECT kind FROM feature WHERE id = '${id}'`)).toBe('forest');
        expect(psql(`SELECT props ->> 'leaf_type' FROM feature WHERE id = '${id}'`))
            .toBe('broadleaved');
        // feature.geom is GeometryZ: the tab put the third ordinate on.
        expect(psql(`SELECT geometrytype(geom) || ' ' || st_ndims(geom)
                     FROM feature WHERE id = '${id}'`)).toBe('POLYGON 3');
        expect(psql(`SELECT st_within(f.geom, a.geom)::text FROM feature f
                     JOIN area a ON a.id = f.area_id WHERE f.id = '${id}'`),
        'what was drawn landed inside the area it was drawn in').toBe('true');

        // Invariant 4: the trigger marked every tile the forest covers.
        const covered = psql(`SELECT count(*) FROM tiles_for_geom(
            (SELECT geom FROM feature WHERE id = '${id}'), 14, 14)`);
        const dirty = psql(`SELECT count(*) FROM tiles_for_geom(
            (SELECT geom FROM feature WHERE id = '${id}'), 14, 14) g
            JOIN tile t ON t.z = g.z AND t.x = g.x AND t.y = g.y WHERE t.dirty`);
        expect(Number(covered)).toBeGreaterThan(0);
        expect(dirty).toBe(covered);

        // And the editor reads back what it wrote.
        await expect(page.locator('.edit-count')).toContainText('1 feature(s)');
        expect(errors).toEqual([]);
    });

test('a saved forest can be picked up, re-typed and deleted', async ({ page }) => {
    await open(page, OWNER);
    const id = psql(`SELECT id FROM feature
                     WHERE area_id = '${area}' AND deleted_at IS NULL`);
    // The map is where it was when this was drawn, so the triangle is too.
    const box = await page.locator('#map').boundingBox();
    const inside = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2) - 13];
    await page.mouse.click(...inside);
    await expect(page.locator('.edit-status')).toContainText('forest');
    await expect(page.locator('.edit-field[data-key="leaf_type"]'))
        .toHaveValue('broadleaved');

    await page.selectOption('.edit-field[data-key="leaf_type"]', 'needleleaved');
    await page.click('.edit-save');
    await expect(page.locator('.edit-status')).toHaveText(/^saved /);
    expect(psql(`SELECT props ->> 'leaf_type' FROM feature WHERE id = '${id}'`))
        .toBe('needleleaved');
    expect(psql(`SELECT rev FROM feature WHERE id = '${id}'`), 'the row is at rev 2').toBe('2');

    await page.mouse.click(...inside);
    await page.click('.edit-delete');
    await expect(page.locator('.edit-status')).toHaveText(/^deleted /);
    // The world is filtered on deleted_at, not emptied of the row.
    expect(psql(`SELECT (deleted_at IS NOT NULL)::text FROM feature
                 WHERE id = '${id}'`)).toBe('true');
    expect(features()).toBe(0);
});

test("an edit grantee's forest becomes a proposal and changes nothing",
    async ({ page }) => {
        const before = features();
        await open(page, PROPOSER);
        await expect(page.locator('.edit-perm'))
            .toHaveText('your changes here become proposals');

        await page.click('.edit-draw');
        await drawTriangle(page, 160);
        await page.click('.edit-save');
        await expect(page.locator('.edit-status')).toHaveText(/^proposed /);

        expect(features(), 'the world must not have moved').toBe(before);
        expect(proposals()).toBe(1);
        expect(psql(`SELECT diff -> 'ops' -> 0 ->> 'op' FROM proposal
                     WHERE area_id = '${area}' AND state = 'open'`)).toBe('insert');
        // A proposal carries GeoJSON; diff_geom() forces it 3D when it merges.
        expect(psql(`SELECT diff -> 'ops' -> 0 -> 'values' -> 'geom' ->> 'type'
                     FROM proposal WHERE area_id = '${area}' AND state = 'open'`))
            .toBe('Polygon');
    });

test('a stranger is refused by the panel and then by the database',
    async ({ page }) => {
        const before = features();
        await open(page, STRANGER);
        // No area of their own, so the map has to be moved over this one.
        await page.evaluate(([lon, lat]) => {
            const view = window.splatworld.edit.map.getView();
            view.setCenter(window.ol.proj.fromLonLat([lon, lat]));
            view.setZoom(15);
        }, [WEST + 0.05, SOUTH + 0.05]);
        await page.evaluate(() => window.splatworld.edit.refresh());
        await expect(page.locator('.edit-perm')).toHaveText(/read-only/);

        await page.click('.edit-draw');
        await drawTriangle(page);
        await page.click('.edit-save');
        await expect(page.locator('.edit-status')).toContainText('you may not edit');

        // The panel only says what the policy would: with the panel out of the
        // way, the write is still refused.
        const refused = await page.evaluate(async (areaId) => {
            const { api } = window.splatworld;
            try {
                await api.insert('feature', [{ area_id: areaId, kind: 'forest',
                    geom: 'SRID=4326;POLYGON Z ((31.04 31.04 0, 31.05 31.04 0, '
                        + '31.05 31.05 0, 31.04 31.04 0))' }]);
                return 'allowed';
            } catch (err) { return String(err.status ?? err.message); }
        }, area);
        expect(refused).not.toBe('allowed');
        expect(features()).toBe(before);
        expect(proposals(), 'and a stranger proposes nothing either').toBe(1);
    });
