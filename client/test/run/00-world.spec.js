// The harness proving itself, before any story stands on it: an empty world
// came up, and the page loads over it. Not a story — no player does anything
// here. If this fails, nothing below it means anything.

import { test, expect, open } from './players.js';

test('the world comes up empty, and the page opens over it', async ({ browser, world },
    testInfo) => {
    // Nothing has been prepared: no ground cut, no account, no land.
    const setup = await fetch(`${world.filesUrl}/setup/state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    expect(setup.account, 'a fresh world has no account').toBe('');
    expect(setup.areas, 'a fresh world has no land').toBe(0);
    expect(setup.geoserver_url, 'a fresh world has no ground').toBe('');

    // The GeoServer publishes exactly one coverage, with an extent, so the
    // operator has something to pick in story 1.
    const caps = await fetch(`${world.geoserverUrl}`
        + '/wcs?service=WCS&version=1.0.0&request=GetCapabilities').then((r) => r.text());
    expect(caps, 'the GeoServer publishes a coverage').toContain('CoverageOfferingBrief');

    const a = await open(browser, world, 'A', testInfo);
    await expect(a.page).toHaveTitle(/./);
    await expect(a.page.locator('canvas').first()).toBeVisible();
    await a.close();
});
