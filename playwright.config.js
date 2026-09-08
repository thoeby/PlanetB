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
    timeout: 120000,
    expect: { timeout: 20000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: 'http://splatworld.test/',
        launchOptions: {
            ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
            // No GPU here; ANGLE over SwiftShader gives a real WebGL2 context.
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
        },
    },
});
