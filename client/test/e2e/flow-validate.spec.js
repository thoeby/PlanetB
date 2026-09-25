// A flow, asked of a real process server.
//
// The samples are what a process server itself exported, so it must say yes to
// every one of them. There is no process server in this container, so the test
// says so and skips rather than passing vacuously: set ELX_URL to the address
// of one and it runs (`make flow-test`).

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT } from './serve.js';

const SAMPLES = join(CLIENT, 'flow/samples');
const URL_ = (process.env.ELX_URL ?? '').replace(/\/+$/, '');

const samples = () => readdirSync(SAMPLES).filter((f) => f.endsWith('.elx'));

// LV.3: every composite of the world's own plugins is a flow too, and a server
// that runs them must say yes to it.
const COMPOSITES = ['world', 'motion', 'interact'].flatMap((p) =>
    readdirSync(join(CLIENT, 'flow', p, 'assets/nodes'))
        .map((f) => join(CLIENT, 'flow', p, 'assets/nodes', f)));

test.beforeAll(() => {
    if (!URL_) test.skip(true, 'flow-test: ELX_URL not set, server validation skipped');
});

// The envelope, read the way client/flow/server/envelope.js reads it — by hand here,
// because this runs in node and that file is the browser's.
function codeOf(xml) {
    const m = /<code>\s*(-?\d+)\s*<\/code>/.exec(xml);
    return m ? Number(m[1]) : (/<elx_api_msg[\s>]/.test(xml) ? 0 : null);
}

for (const name of samples()) {
    test(`the process server would run ${name}`, async () => {
        const elx = readFileSync(join(SAMPLES, name), 'utf8');
        const res = await fetch(`${URL_}/api/v1/process/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
            body: elx,
        });
        const text = await res.text();
        expect(res.ok, `${name}: HTTP ${res.status}`).toBe(true);
        expect(codeOf(text), `${name}: ${text.slice(0, 300)}`).toBe(0);
    });
}

for (const file of COMPOSITES) {
    test(`the process server would run the composite ${file.split('/flow/')[1]}`, async () => {
        const res = await fetch(`${URL_}/api/v1/process/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
            body: readFileSync(file, 'utf8'),
        });
        const text = await res.text();
        expect(res.ok, `${file}: HTTP ${res.status}`).toBe(true);
        expect(codeOf(text), `${file}: ${text.slice(0, 300)}`).toBe(0);
    });
}
