// Browser tests. The page is served by route interception rather than a real
// server: client/ is static files, so reading them off disk is the same thing
// with fewer moving parts.
//
// The bundled chromium download is skipped in environments that ship one
// already (PLAYWRIGHT_BROWSERS_PATH); point at it when it is there.

import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const preinstalled = '/opt/pw-browsers/chromium';

export default defineConfig({
    testDir: 'client/test/e2e',
    // Specs only. client/test/e2e/flow/ holds the reference editor's own test
    // files, which are modules a *page* loads (flow-modules.spec.js opens it);
    // playwright's default pattern would take them for node specs and fail on
    // their absolute imports.
    testMatch: '**/*.spec.js',
    timeout: 120000,
    expect: { timeout: 20000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: 'http://splatworld.test/',
        // A spec that compiles a tile in software needs minutes, so the test
        // timeouts are long (up to 900 s in build.spec.js) — but a click on
        // something that is not there is never slow, it is wrong, and without
        // its own limit it waits out the whole test. One dropped selector cost
        // a quarter of an hour of a suite run; now it costs fifteen seconds.
        actionTimeout: 15000,
        navigationTimeout: 60000,
        launchOptions: {
            ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
            // No GPU here; ANGLE over SwiftShader gives a real WebGL2 context.
            // WebGPU is deliberately not turned on (HANDOFF §1 says how, and
            // the specs that need it ask for it themselves): a tab that has
            // it takes training atoms, and training a real tile on SwiftShader
            // is hours. What that costs is in PROGRESS.md.
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
        },
    },
});
