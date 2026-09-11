// What a browser test needs to drive the worker loop: the psql side of the
// fixtures, and the page with a signed-in tab.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT } from './serve.js';

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

// Everything a job's atoms made, gone: the rows and the bytes.
//
// A fixture that rebuilds a DAG deletes the atoms that produced last run's
// artifacts, and an artifact whose atom is gone is registered but unfindable —
// client/js/inputs.js locates bytes by asking which atom produced them, and
// can_write refuses to write a path for an artifact that already exists. So the
// artifacts go with the atoms, files included.
export function resetJob(job) {
    const made = psql(`SELECT coalesce(string_agg(
                           coalesce(output_sha256, '') || ' ' || coalesce(result ->> 'path', ''),
                           E'\n'), '')
                       FROM atom WHERE job_id = ${job}`);
    // The atoms go first: atom.output_sha256 references artifact.
    psql(`DELETE FROM atom WHERE job_id = ${job}`);
    for (const line of made.split('\n').filter(Boolean)) {
        const path = line.split(' ')[1];
        if (path) rmSync(join(FILES_ROOT, path.replace(/^\//, '')), { force: true });
    }
    // Anything nobody points at any more, including what earlier runs left
    // behind. An unreferenced artifact row is worse than useless: can_write
    // refuses to write its bytes anywhere, and no atom can say where they are.
    psql(`DELETE FROM artifact a
          WHERE NOT EXISTS (SELECT 1 FROM atom WHERE output_sha256 = a.sha256)
            AND NOT EXISTS (SELECT 1 FROM tile WHERE sog_sha256 = a.sha256)
            AND NOT EXISTS (SELECT 1 FROM tile WHERE candidate_sha256 = a.sha256)
            AND NOT EXISTS (SELECT 1 FROM asset WHERE sha256 = a.sha256)
            AND NOT EXISTS (SELECT 1 FROM asset WHERE thumb_sha256 = a.sha256)
            AND a.kind NOT IN ('dem', 'ortho')`);
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
    await revealPanels(page);
}

// play.html's panels live in tabs now (client/js/hud.js) and only the open one
// is shown. A spec is about what a panel does, not about which tab is open, so
// every body is revealed once and the selectors go on working. Pages without
// the chrome — edit.html, catalog.html — are left alone.
export async function revealPanels(page) {
    await page.waitForFunction(() => window.splatworld !== undefined, null,
        { timeout: 60000 }).catch(() => {});
    await page.evaluate(() => {
        const panel = document.getElementById('panel');
        if (!panel || !window.splatworld?.hud) return;
        panel.dataset.open = '1';
        for (const body of panel.querySelectorAll('.tab-body')) body.hidden = false;
    }).catch(() => {});
}

export async function signIn(page, email, pw) {
    await page.waitForFunction(() => window.splatworld?.work, null, { timeout: 60000 });
    await page.evaluate(async ([e, p]) => {
        const { api } = window.splatworld;
        await api.register(e, p).catch(() => {});
        await api.login(e, p);
    }, [email, pw]);
}
