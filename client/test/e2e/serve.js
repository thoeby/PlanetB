// Serves client/ (and the vendored engine, and the published .sog files) to the
// page by intercepting its requests. Nothing listens on a port: these are static
// files and the file store is a directory of immutable blobs.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

export const CLIENT = new URL('../../', import.meta.url).pathname;
export const REPO = new URL('../../../', import.meta.url).pathname;
export const FILES_ROOT = process.env.FILES_ROOT
    ? join(REPO, process.env.FILES_ROOT.replace(/^\.\//, ''))
    : join(REPO, 'infra/files');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
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
