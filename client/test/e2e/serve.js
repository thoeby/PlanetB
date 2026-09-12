// Serves client/ (and the vendored engine, and the published .sog files) to the
// page by intercepting its requests. Nothing listens on a port: these are static
// files and the file store is a directory of immutable blobs.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

export const CLIENT = new URL('../../', import.meta.url).pathname;
export const REPO = new URL('../../../', import.meta.url).pathname;
export const FILES_ROOT = process.env.FILES_ROOT
    ? join(REPO, process.env.FILES_ROOT.replace(/^\.\//, ''))
    : join(REPO, 'infra/files');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    // A browser refuses a stylesheet served as anything else, and then the
    // page renders correctly and completely unstyled.
    '.css': 'text/css', '.woff2': 'font/woff2',
    '.sog': 'application/octet-stream', '.webp': 'image/webp',
};
const mime = (p) => TYPES[extname(p)] ?? 'application/octet-stream';

// The tile rows the API would serve. Read straight from the database: these are
// the tiles tools/make-test-tiles.mjs published, manifests and all.
export function tileRows() {
    const sql = `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.z, t.x, t.y), '[]')
                 FROM (SELECT z, x, y, dirty, published_version, sog_sha256, manifest
                       FROM tile WHERE published_version > 0) t`;
    const out = execFileSync('psql',
        ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A', '-c', sql],
        { encoding: 'utf8', env: process.env });
    return JSON.parse(out);
}

// The seven tiles tools/make-test-tiles.mjs publishes. WP1's browser tests
// assert exact sets of loaded tiles, so they are given exactly this world:
// since WP2.8 the database also holds compiled tiles of the pilot region, and
// which of those happens to be published is not what those tests are about.
export const TEST_TILES = new Set([
    '10/535/361', '10/535/362', '10/536/361', '10/536/362',
    '8/133/90', '8/134/90', '6/33/22',
]);

export const testTileRows = () =>
    tileRows().filter((r) => TEST_TILES.has(`${r.z}/${r.x}/${r.y}`));

// Ground for a spec, without a GeoServer.
//
// The world's elevation comes from the operator's coverage, cut per tile by the
// server (server/splatworld/ground.py). A test has no GeoServer, so it writes
// the same bytes the cut would have written — dem-v1, 256x256, a gentle ramp so
// a walk has something to climb — and tells the database the world is here.
// Nothing about the compile path is special-cased: the atom reads the same file
// at the same address.
export function seedGround(z, x, y, { slopeMetres = 120 } = {}) {
    const n = 256;
    const samples = new Uint16Array(n * n);
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            // dem-v1: metres = value * 0.2 - 500, so sea level is 2500.
            const metres = 400 + (slopeMetres * (col + row)) / (2 * n);
            samples[row * n + col] = Math.round((metres + 500) / 0.2);
        }
    }
    const dir = join(FILES_ROOT, `geo/dem/${z}/${x}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${y}.r16`), Buffer.from(samples.buffer));
    const span = 360 / 2 ** z;
    const west = x * span - 180;
    psqlHere(`INSERT INTO ground (only_one, geoserver_url, coverage, extent)
              VALUES (true, 'http://test.invalid/geoserver', 'test:ground',
                      st_makeenvelope(${west - span}, -80, ${west + 2 * span}, 80, 4326))
              ON CONFLICT (only_one) DO UPDATE SET extent = excluded.extent`);
    return join(dir, `${y}.r16`);
}

// A world to compile, drawn rather than imported. One area over the tile with a
// forest and a building in it: enough for assemble to have something to build,
// and nothing that came from OSM (TASKS-usable: the world is what people draw).
export function seedWorld(z, x, y) {
    const span = 360 / 2 ** z;
    const west = x * span - 180;
    const lat = (row) => (180 / Math.PI)
        * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + row)) / 2 ** z)));
    const north = lat(0);
    const south = lat(1);
    const at = (fx, fy) => `${west + fx * span} ${south + fy * (north - south)}`;
    const ring = (a, b, c, d) => `POLYGON((${a},${b},${c},${d},${a}))`;
    const wood = ring(at(0.1, 0.1), at(0.4, 0.1), at(0.4, 0.4), at(0.1, 0.4));
    const house = ring(at(0.6, 0.6), at(0.7, 0.6), at(0.7, 0.7), at(0.6, 0.7));
    psqlHere(`DO $$
        DECLARE uid uuid; aid uuid;
        BEGIN
            SELECT id INTO uid FROM auth.user WHERE email = 'world@test.local';
            IF uid IS NULL THEN uid := register('world@test.local', 'seedseed'); END IF;
            SELECT id INTO aid FROM area WHERE rules ->> 'seed' = '${z}/${x}/${y}';
            IF aid IS NULL THEN
                INSERT INTO area (geom, owner_id, detail, rules) VALUES (
                    st_makeenvelope(${west}, ${south}, ${west + span}, ${north}, 4326),
                    uid, 14, jsonb_build_object('seed', '${z}/${x}/${y}',
                                                'required_approvals', 1))
                RETURNING id INTO aid;
                INSERT INTO feature (area_id, kind, geom, props) VALUES
                    (aid, 'forest',
                     st_force3d(st_geomfromtext('${wood}', 4326)),
                     '{"leaf_type": "broadleaved"}'),
                    (aid, 'footprint',
                     st_force3d(st_geomfromtext('${house}', 4326)),
                     '{"height": 9, "roof": "gabled"}');
            END IF;
        END $$`);
}

const psqlHere = (sql) => execFileSync('psql',
    ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A', '-c', sql],
    { encoding: 'utf8', env: process.env }).trim();

// Does the ground cover this tile? Walks the same ancestor fallback
// client/lib/geo.js does.
export function demSeeded(z, x, y) {
    for (let az = z; az >= 6; az -= 2) {
        const f = 2 ** (z - az);
        const p = join(FILES_ROOT,
            `geo/dem/${az}/${Math.floor(x / f)}/${Math.floor(y / f)}.r16`);
        if (existsSync(p)) return true;
    }
    return false;
}

export async function install(page, rows) {
    // Tile rows are read fresh on every request when no snapshot is given, so a
    // republish made during a test is visible to the page's next poll.
    await page.route('https://code.playcanvas.com/**', (route) => {
        const local = join(CLIENT, 'vendor/playcanvas/playcanvas.js');
        route.fulfill({ contentType: 'text/javascript', body: readFileSync(local) });
    });
    await page.route('http://localhost:3000/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/tile') return route.fulfill({ status: 404, body: '[]' });
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(rows ?? tileRows()),
        });
    });
    await page.route('http://localhost:8080/**', (route) => {
        const p = join(FILES_ROOT, new URL(route.request().url()).pathname);
        if (!existsSync(p)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: mime(p), body: readFileSync(p) });
    });
    await page.route('http://splatworld.test/**', (route) => {
        const p = join(CLIENT, new URL(route.request().url()).pathname);
        if (!existsSync(p)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: mime(p), body: readFileSync(p) });
    });
}
