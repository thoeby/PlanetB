// The players, and what they are allowed to do.
//
// A player has the page and nothing else. These helpers are deliberately thin:
// anything that reaches past a visible control — page.evaluate into app state,
// an RPC, a row written by hand — is not a player doing it, and PLAYER-RUN.md
// says a story proven that way is not proven.

import { test as base, expect } from '@playwright/test';

import { startWorld } from './world.js';

// A player waits on the world changing, never on the clock.
export const UI = 30_000;
export const RENDER = 600_000;

// Every page a test opened, so the report can carry what their consoles said.
const opened = new Map();

export const test = base.extend({
    world: [async ({}, use) => {
        const world = await startWorld();
        // Which GeoServer answered, in the run's output: a story that passed
        // against the fixture has passed against the fixture only.
        process.stdout.write(`\n  world: ${world.pageUrl}`
            + `\n  geoserver (${world.geoserverKind}): ${world.geoserverUrl}\n\n`);
        await use(world);
        world.stop();
    }, { scope: 'worker', auto: false, timeout: 900_000 }],

    // PLAYER-RUN.md, "Report": on failure, the console of every page in the
    // story, next to the screenshot Playwright already kept. That report is
    // the whole bug description.
    report: [async ({}, use, testInfo) => {
        opened.set(testInfo, []);
        await use(null);
        if (testInfo.status !== testInfo.expectedStatus) {
            for (const player of opened.get(testInfo) ?? []) {
                await testInfo.attach(`${player.name} console`, {
                    body: player.console.join('\n') || '(said nothing)',
                    contentType: 'text/plain',
                });
                await testInfo.attach(`${player.name} screen`, {
                    body: await player.page.screenshot().catch(() => Buffer.alloc(0)),
                    contentType: 'image/png',
                });
            }
        }
        opened.delete(testInfo);
    }, { auto: true }],
});

export { expect };

// One player: a browser context of their own, so their sign-in is theirs.
export async function open(browser, world, name, testInfo) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const console_ = [];
    page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => console_.push(`pageerror: ${e.message}`));
    await page.goto(world.pageUrl);
    const player = { name, page, context, console: console_, close: () => context.close() };
    opened.get(testInfo)?.push(player);
    return player;
}

// What the page says, anywhere on it. Stories assert sentences, so the failure
// report is the sentence that was missing.
export const says = (page, text) => page.getByText(text, { exact: false }).first();

export async function shows(player, text, timeout = UI) {
    await expect(says(player.page, text), `${player.name} should be told "${text}"`)
        .toBeVisible({ timeout });
}

// The panel tabs along the bottom of the page (design 3k). Pressing the tab
// that is already open closes it, as it should — so a player who is already
// looking at a panel does not press it again, and neither does this.
export async function panel(player, name) {
    const tab = player.page.locator(`#tabs button[data-tab="${name}"]`);
    if (await tab.getAttribute('aria-selected') === 'true') return;
    await tab.click();
}
