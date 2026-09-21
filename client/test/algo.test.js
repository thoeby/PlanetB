// The version of each op is written in three places: the atom module that
// builds it, the table the tab tells claim_atom about, and the database's
// algo_current(). They drifted once (train-v13 against train-v14) and every
// train piece in the world was claimed, refused and counted as an attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ALGO } from '../js/workcaps.js';

test('workcaps ALGO names the version each atom module builds', () => {
    for (const op of Object.keys(ALGO)) {
        const src = readFileSync(new URL(`../atoms/${op}.js`, import.meta.url), 'utf8');
        const m = /export const ALGO = '([^']+)'/.exec(src);
        assert.equal(ALGO[op], m?.[1], `client/atoms/${op}.js builds ${m?.[1]}`);
    }
});

test('workcaps ALGO is what the newest migration says the world builds', () => {
    const dir = new URL('../../db/', import.meta.url);
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    let table = null;
    for (const f of files) {
        const src = readFileSync(new URL(f, dir), 'utf8');
        const body = /FUNCTION algo_current\(p_op text\)[\s\S]*?\$\$;/.exec(src)?.[0];
        if (body) table = body;
    }
    assert.ok(table, 'db defines algo_current()');
    for (const [op, v] of Object.entries(ALGO)) {
        const m = new RegExp(`WHEN '${op}' THEN '([^']+)'`).exec(table);
        assert.equal(v, m?.[1], `algo_current('${op}')`);
    }
});
