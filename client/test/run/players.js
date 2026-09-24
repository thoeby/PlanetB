// The players, and what they are allowed to do.
//
// A player has the page and nothing else. These helpers are deliberately thin:
// anything that reaches past a visible control — page.evaluate into app state,
// an RPC, a row written by hand — is not a player doing it, and PLAYER-RUN.md
// says a story proven that way is not proven.

import { test as base, expect } from '@playwright/test';

import { startWorld } from './world.js';
import { surfaceOf, viewOf } from '../../js/tabbar.js';

// A player waits on the world changing, never on the clock.
export const UI = 30_000;
export const RENDER = 600_000;

// Every player in the run uses the same one: what is being proven is never
// the password.
export const PASSWORD = 'a-long-enough-password';

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
    await page.bringToFront();
    const player = { name, page, context, console: console_, close: () => context.close() };
    opened.get(testInfo)?.push(player);
    return player;
}

// What the page says, anywhere on it. Stories assert sentences, so the failure
// report is the sentence that was missing.
//
// Whichever one of them a person could actually read, not whichever the DOM
// holds first. A land's name is written twice — on the ground as a world label
// and in the panel that lists it — and the label is hidden whenever the player
// is not looking that way. `.first()` took that hidden one as soon as it
// existed, so whether a story passed came down to which of the two the page
// had got round to drawing.
export const says = (page, text) =>
    page.getByText(text, { exact: false }).locator('visible=true').first();

export async function shows(player, text, timeout = UI) {
    await expect(says(player.page, text), `${player.name} should be told "${text}"`)
        .toBeVisible({ timeout });
}

// Making an account and coming back to it. Every story after the first needs
// both, so they live here rather than in four copies.
//
// The assertion is the account panel's own status line, not "the name appears
// somewhere on the page": a product called "Valais bench" contains "Ben".
export async function signUp(player, email, name) {
    const { page } = player;
    await panel(player, 'Setup');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('password').fill(PASSWORD);
    await page.getByRole('button', { name: 'create account' }).click();
    await expect(page.getByText(email).first()).toBeVisible({ timeout: UI });
    await page.getByLabel('your name').fill(name);
    await page.getByRole('button', { name: 'save name' }).click();
    await expect(page.locator('.auth-status')).toContainText(name, { timeout: UI });
}

export async function signIn(player, email, name) {
    const { page } = player;
    await panel(player, 'Setup');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('password').fill(PASSWORD);
    // The form's own button, not the profile chip on the bar — which says
    // "Sign in" too when nobody is signed in, and an accessible name is
    // matched as a substring unless it is asked to be the whole of it.
    await page.getByRole('button', { name: 'sign in', exact: true }).click();
    await expect(page.locator('.auth-status')).toContainText(name, { timeout: UI });
}

// The window this player is looking at. A tab nobody is looking at has its
// animation frames throttled by the browser, and the 3D view is what writes the
// position line, what is under you and what is on screen — so a story that
// reads any of those from a player who is not in front reads what was there
// when they last looked. A person has one window in front of them; this says
// which.
export const looking = (player) => player.page.bringToFront();

// The bar along the bottom of the page (design 5a). Pressing the button that
// is already open closes it, as it should — so a player who is already looking
// at a panel does not press it again, and neither does this.
//
// Several surfaces hold more than one thing (Publish holds Submit and Approve,
// Settings holds Setup and the admin tools), so a name is either a button on
// one of the two bars — the plinth along the bottom or the strip along the top
// — or a tab inside the surface that names it in data-parts. All of them are
// reached the same way from a story.
export async function panel(player, name) {
    await looking(player);
    const page = player.page;
    const bars = '#tabs, #top';
    const tab = page.locator(`:is(${bars}) button[data-tab="${name}"]`);
    if (await tab.count()) {
        if (await tab.getAttribute('aria-selected') === 'true') return;
        await tab.click();
        return;
    }
    const holder = page.locator(`:is(${bars}) button[data-parts*=",${name},"]`);
    // A surface that is a whole view is on neither bar: Survey's map is
    // reached by switching to Survey, the way a player reaches it. The view
    // opens its own first part, so only a second part needs pressing.
    if (await holder.count()) {
        if (await holder.getAttribute('aria-selected') !== 'true') await holder.click();
    } else {
        const view = viewOf(name);
        if (!view) throw new Error(`no surface, part or view holds "${name}"`);
        await panelApp(player, view);
    }
    // A surface asked for by its own name opens its first part: Work became a
    // window of queues ('Every job' first, tabbar.js), and the stories that
    // ask for "Work" mean the pool as a whole.
    const leaf = surfaceOf(name)?.part ?? name;
    const part = page.locator(`#panel .parts button[data-tab="${leaf}"]`);
    if (await part.getAttribute('aria-selected') !== 'true') await part.click();
}

// A view, by its card in the drawer (SPEC §2.1 Views). A player who wants
// another workspace presses Tab and picks it off the card that says what it
// is; nobody memorises F-keys on their first day, so neither does this.
//
// `where` is a page or a player, because a story holds players and the
// harness's own checks hold pages.
export async function panelApp(where, name) {
    const page = where.page ?? where;
    if (page.bringToFront) await page.bringToFront();
    const drawer = page.locator('#apps');
    if (await drawer.isHidden()) await page.keyboard.press('Tab');
    await drawer.waitFor({ state: 'visible', timeout: UI });
    const card = drawer.locator(`.app-card[data-app="${name}"]`);
    await card.waitFor({ state: 'visible', timeout: UI });
    await card.click();
    await expect(page.locator('#top .app-tab[aria-selected="true"] .name'))
        .toHaveText(name, { timeout: UI });
}
