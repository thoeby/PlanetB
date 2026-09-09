// What a browser test needs to drive the worker loop: the psql side of the
// fixtures, and the page with a signed-in tab.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';

export const psql = (sql) => execFileSync('psql',
    ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A', '-c', sql],
    { encoding: 'utf8', env: process.env }).trim();

// claim_atom picks globally (db/0005_state.sql), so anything else that is ready
// would be handed to the tab under test. Everything claimable is set aside for
// the duration and put back afterwards, the same way tools/make-test-tiles.mjs
// and publish.js do.
export function park() {
    const ids = psql("UPDATE atom SET state = 'waiting' WHERE state = 'ready' RETURNING id");
    return ids ? ids.split('\n').filter(Boolean) : [];
}

export function unpark(ids) {
    if (ids?.length) psql(`UPDATE atom SET state = 'ready' WHERE id IN (${ids.join(',')})`);
}

// A tile nobody else is compiling, an open job for it, and one ready atom.
export function readyAtom({ z, x, y, op, algo, params, inputs = {} }) {
    psql(`INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (${z}, ${x}, ${y}, true, 1)
          ON CONFLICT (z, x, y) DO UPDATE SET dirty = true`);
    const job = psql(`INSERT INTO job (z, x, y, target_version, state)
                      VALUES (${z}, ${x}, ${y}, 1, 'open')
                      ON CONFLICT (z, x, y, target_version) DO UPDATE SET state = 'open'
                      RETURNING id`);
    return psql(`INSERT INTO atom (job_id, atom_hash, op, algo_version, inputs, params, state)
                 VALUES (${job}, encode(public.digest(random()::text, 'sha256'), 'hex'),
                         '${op}', '${algo}', '${JSON.stringify(inputs)}'::jsonb,
                         '${JSON.stringify(params)}'::jsonb, 'ready')
                 RETURNING id`);
}

// Only the engine is intercepted: the API, the file store and the page itself
// are real servers on localhost, because a worker tab writes.
export async function openPage(page, pageUrl) {
    await page.route('https://code.playcanvas.com/**', (route) => route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js')),
    }));
    await page.goto(pageUrl);
}

export async function signIn(page, email, pw) {
    await page.waitForFunction(() => window.splatworld?.work, null, { timeout: 60000 });
    await page.evaluate(async ([e, p]) => {
        const { api } = window.splatworld;
        await api.register(e, p).catch(() => {});
        await api.login(e, p);
    }, [email, pw]);
}

// Whether the seeded DEM covers a tile the way client/lib/geo.js looks for it:
// the tile itself, or an ancestor two zooms up, and so on. The pilot's tiles
// need `bash tools/seed-dem.sh`; the gate's seed-test cuts one z14 tile only.
export function demSeeded(root, { z, x, y }) {
    for (let az = z; az >= 6; az -= 2) {
        const f = 2 ** (z - az);
        const p = join(root, `geo/dem/${az}/${Math.floor(x / f)}/${Math.floor(y / f)}.r16`);
        if (existsSync(p)) return true;
    }
    return false;
}
