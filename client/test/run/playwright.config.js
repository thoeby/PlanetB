// The player-run: one script, behaving like a player, through the page.
//
// Separate from client/test/e2e on purpose. Those specs test parts, with the
// page's requests intercepted; this one runs a whole world — an empty
// database, the server, a GeoServer — and proves the stories in docs/SPEC.md §3
// end to end, in order, in one run. PLAYER-RUN.md is the task list.

import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const preinstalled = '/opt/pw-browsers/chromium';

export default defineConfig({
    testDir: '.',
    // A story is allowed to render a tile, which is minutes on a software
    // adapter. A story that has nothing to render is nowhere near this.
    timeout: 900_000,
    expect: { timeout: 30_000 },
    // Stories run in order and each stands on the last one's world.
    fullyParallel: false,
    workers: 1,
    // A story that fails leaves the world where it was for the next run to be
    // told about; carrying on into the next story proves nothing.
    maxFailures: 1,
    // Kept at the repo root, where the other suite's are and where .gitignore
    // already knows about them — a report written next to the specs is a
    // megabyte of vendored javascript for `make lint` to read.
    outputDir: '../../../test-results/run',
    reporter: [['list'],
        ['html', { open: 'never', outputFolder: '../../../playwright-report/run' }]],
    use: {
        actionTimeout: 15_000,
        navigationTimeout: 60_000,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        launchOptions: {
            ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
            args: [
                // No GPU here; ANGLE over SwiftShader gives a real WebGL2
                // context, and Dawn a real WebGPU device on a secure origin.
                '--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
                '--enable-unsafe-webgpu',
            ],
        },
    },
});
