// WP2.2's acceptance: a tab claims an atom, runs it in a Web Worker, uploads
// what it made, registers it and submits it — against the real PostgREST, the
// real nginx file store and the real database. The atom is `noop`, which
// computes nothing about the world; everything around it is production code.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT, FILES_ROOT } from './serve.js';
import { startServices } from './services.js';
import { openPage, park, psql, readyAtom, signIn, unpark } from './worker.js';

const EMAIL = 'work-e2e@splatworld.local';
const PW = 'work-e2e-password';

let svc = null;
let parked = [];

// A tile nobody else is compiling, a job for it, and one noop atom, ready.
const makeAtom = (suffix) => readyAtom({
    z: 14, x: 9000, y: 5000 + (Number(process.pid) % 1000) + suffix,
    op: 'noop', algo: 'noop-v1', params: { note: 'wp2.2' },
});

const open = (page) => openPage(page, svc.pageUrl);
const enter = (page) => signIn(page, EMAIL, PW);

test.describe.configure({ timeout: 120000 });

test.beforeAll(async () => {
    if (!existsSync(join(CLIENT, 'vendor/playcanvas/playcanvas.js'))) {
        test.skip(true, 'no vendored engine — run `make vendor`');
    }
    try { psql('SELECT 1'); } catch (err) {
        test.skip(true, `no database: ${err.message}`);
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

test('a tab claims an atom, runs it in a worker, uploads it and submits it',
    async ({ page }) => {
        const atom = makeAtom(1);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await open(page);
        await enter(page);

        // The panel's own switch, not a back door: this is what a player flips.
        await page.locator('.work-toggle').check();

        await expect.poll(() => psql(`SELECT state FROM atom WHERE id = ${atom}`),
            { timeout: 60000 }).toBe('verified');
        await page.locator('.work-toggle').uncheck();

        const [sha, kind, seconds] = psql(
            `SELECT a.output_sha256 || '|' || art.kind || '|'
                    || (a.result ->> 'gpu_seconds' IS NOT NULL)
             FROM atom a JOIN artifact art ON art.sha256 = a.output_sha256
             WHERE a.id = ${atom}`).split('|');
        expect(sha).toMatch(/^[0-9a-f]{64}$/);
        expect(kind).toBe('ply');
        expect(seconds).toBe('true');

        // The bytes are where the claim reserved room for them, and the store
        // serves them back immutable.
        expect(existsSync(join(FILES_ROOT, `jobs/${atom}/${sha}.json`))).toBe(true);
        const res = await fetch(`${svc.filesUrl}/jobs/${atom}/${sha}.json`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('immutable');
        expect(JSON.parse(await res.text()).op).toBe('noop');

        // Registration recorded the caps the tab claimed with.
        const caps = psql(`SELECT w.caps::text FROM worker w
                           JOIN auth.user u ON u.id = w.user_id
                           WHERE u.email = '${EMAIL}'`);
        expect(JSON.parse(caps).algo.sog).toBe('sog-v1');
        expect(JSON.parse(caps)).toHaveProperty('webgpu');

        const log = await page.locator('.work-log').textContent();
        expect(log).toContain('submit');
        expect(errors).toEqual([]);
    });

test('a heartbeat keeps a claim alive across six minutes, and silence loses it',
    async ({ page }) => {
        const atom = makeAtom(2);
        await open(page);
        await enter(page);

        const claimed = await page.evaluate(
            () => window.splatworld.api.rpc('claim_atom', { caps: {} }));
        expect(String(claimed.id)).toBe(atom);

        // Six minutes of wall clock, without waiting six minutes. The loop's own
        // 60 s beat is asserted in client/test/work.test.js; what matters here is
        // that a beat is what stops expire_claims() taking the atom back.
        const age = (m) => psql(`UPDATE atom SET claimed_at = now() - interval '${m} minutes',
                                 heartbeat_at = now() - interval '${m} minutes'
                                 WHERE id = ${atom}`);
        age(6);
        await page.evaluate(
            (id) => window.splatworld.api.rpc('heartbeat', { atom_id: Number(id) }), atom);
        psql('SELECT expire_claims()');
        expect(psql(`SELECT state || '|' || attempts FROM atom WHERE id = ${atom}`))
            .toBe('claimed|0');

        age(6);
        psql('SELECT expire_claims()');
        expect(psql(`SELECT state || '|' || attempts FROM atom WHERE id = ${atom}`))
            .toBe('ready|1');
        psql(`UPDATE atom SET state = 'waiting' WHERE id = ${atom}`);
    });
