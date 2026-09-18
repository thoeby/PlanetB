// The flow editor's own modules, in a browser.
//
// client/flow/ is copied from the reference editor file by file (each file says
// so in its header), and this runs that repository's test suite against the
// copy: parse, serialize, nets, register, import, export, layout, port groups,
// history and hidden outputs, unchanged. If a copy drifts, this is what says
// so. The suite is a page because these modules are the browser's — DOMParser
// and litegraph — so there is nothing for node to run.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { install, CLIENT } from './serve.js';

test('every module copied from the reference editor still passes its own tests',
    async ({ page }) => {
        if (!existsSync(join(CLIENT, 'vendor/litegraph/litegraph.js'))) {
            test.skip(true, 'litegraph is not vendored — run `make vendor`');
        }
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await install(page, []);
        await page.goto('http://splatworld.test/test/e2e/flow/page.html');
        await page.waitForFunction(() => window.__flowTests, null, { timeout: 60000 });

        const failed = await page.locator('#results li')
            .evaluateAll((li) => li.filter((n) => n.textContent.startsWith('FAIL'))
                .map((n) => n.textContent));
        const { passed, failed: n } = await page.evaluate(() => window.__flowTests);
        expect(failed.join('\n')).toBe('');
        expect(n).toBe(0);
        // A suite that registered nothing passes vacuously, which is the one
        // way this test can lie.
        expect(passed).toBeGreaterThan(60);
        expect(errors, errors.join('\n')).toEqual([]);
    });
