// Story 74 — Automate's four tabs, and undo on the bar (TASKS-ui.md UI.8, UI.9).
//
// B opens Automate on its Flows page: his flows as cards. One opens into the
// Editor, where a change is undone from the top bar. The Server control, not a
// tab, decides what the Editor's left column lists: alpha's processes, or his
// own collection. Schedule is the chosen server's Planner. Paths draws a route
// on his field from above and puts a product on it. And in Terrain, the same
// two glyphs on the bar undo and redo the ground.

import { test, expect, open, panelApp, signIn, UI } from './players.js';
import { automateTab, chooseServer, dragIn } from './automate.js';
import { goesToTheLand } from './things.js';
import { pointOfHisLand, shapeHisLand } from './editors.js';

const flows = (b) => b.page.locator('#flows');
const elx = (b) => b.page.evaluate(() => window.splatworld.flows.canvas().elx());

async function theFlowsPage(b) {
    await panelApp(b, 'Automate');
    await expect(flows(b)).toHaveAttribute('data-page', 'flows', { timeout: UI });
    await expect(b.page.locator('#top .fl-pages button'))
        .toHaveText(['Flows', 'Editor', 'Schedule', 'Paths']);
    const card = b.page.locator('#flows .fh-card', { hasText: 'Gate opens' });
    await expect(card).toBeVisible({ timeout: UI });
    await card.getByRole('button', { name: 'Open' }).click();
    await expect(flows(b)).toHaveAttribute('data-page', 'editor', { timeout: UI });
    await expect(b.page.locator('#flows .fl-top .name')).toHaveText('Gate opens',
        { timeout: UI });
}

async function undoneFromTheBar(b) {
    const undo = b.page.locator('#bar-undo');
    await expect(undo).toBeVisible();
    await expect(undo).toHaveAttribute('data-tip', 'Undo');
    const before = await elx(b);
    await dragIn(b, 'strings contains', 'Contains', [0.45, 0.75]);
    await expect.poll(() => elx(b), { timeout: UI }).not.toBe(before);
    await expect(undo).toBeEnabled();
    await undo.click();
    expect(await elx(b), 'the block is gone again').toBe(before);
    await b.page.locator('#bar-redo').click();
    expect(await elx(b)).not.toBe(before);
    await undo.click();
}

async function theServerDecides(b) {
    const head = b.page.locator('#flows .fl-pane-head');
    await expect(head).toHaveText('My collection');
    await expect(b.page.locator('#flows .fl-list li[data-flow]').first()).toBeVisible();
    await chooseServer(b, 'alpha');
    await expect(head).toHaveText('On alpha');
    await expect(b.page.locator('#flows .fl-on-server')).toBeVisible();
    await expect(b.page.locator('#flows .fl-list li[data-flow]').first()).toBeHidden();
    await chooseServer(b, 'My collection');
    await expect(head).toHaveText('My collection');
    await expect(b.page.locator('#flows .fl-top')).toContainText('My collection');
}

async function theSchedule(b) {
    await automateTab(b, 'Schedule');
    await expect(b.page.locator('#flows .fl-sched-none'))
        .toContainText('Schedule a job on a server');
    await chooseServer(b, 'alpha');
    const planner = b.page.locator('#flows .fl-planner');
    await expect(planner).toBeVisible({ timeout: UI });
    await expect(planner.locator('.pl-count')).toContainText('on alpha', { timeout: UI });
}

// Two corners inside the outline of his field, on the map from above.
async function aRoute(b) {
    await automateTab(b, 'Paths');
    const side = b.page.locator('#flows .fp-side');
    await expect(side.getByLabel('Land')).toHaveValue(/.+/, { timeout: UI });
    const outline = b.page.locator('#flows .fp-outline').first();
    await expect(outline).toBeVisible({ timeout: UI });
    const box = await outline.boundingBox();
    for (const [fx, fy] of [[0.4, 0.4], [0.6, 0.6]]) {
        await b.page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    }
    await expect(side.locator('.fp-said')).toContainText('2 corner(s)');
    await side.getByLabel('What moves').fill('Kiste');
    await side.getByLabel('What moves').dispatchEvent('change');
    await side.locator('.fp-found button', { hasText: 'Kiste' }).first().click();
    await side.getByLabel('Name').fill('Kistenbahn');
    await side.getByRole('button', { name: 'Put it on the route' }).click();
    await expect(side.locator('.fp-said')).toHaveText('Kistenbahn is on the route',
        { timeout: UI });
    await expect(side.locator('.fp-movers')).toContainText('Kistenbahn');
}

async function leaves(b) {
    await b.page.locator('#flows .fl-close').click();
    const box = b.page.locator('#flows .fl-ask');
    if (await box.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
        await box.getByRole('button', { name: 'Discard' }).click();
    }
    await expect(flows(b)).toBeHidden({ timeout: UI });
    await expect(b.page.locator('#top .fl-pages')).toHaveCount(0);
}

// UI.9: a stroke on the ground, undone from the bar. Shape opens the clay
// over his land (EDT.6); a press held on it is one stroke.
async function theGround(b) {
    await goesToTheLand(b);
    await shapeHisLand(b);
    const p = await pointOfHisLand(b);
    const undo = b.page.locator('#bar-undo');
    await expect(undo).toBeVisible({ timeout: UI });
    await expect(undo).toBeDisabled();
    await b.page.mouse.move(p.x, p.y);
    await b.page.mouse.down();
    await b.page.waitForTimeout(300);
    await b.page.mouse.up();
    await expect(undo).toBeEnabled({ timeout: UI });
    await undo.click();
    await expect(b.page.locator('.sc-status')).toHaveText('undone');
    await expect(b.page.locator('#bar-redo')).toBeEnabled();
    // Shape closed — nothing unsaved is left to ask about — the glyphs go too.
    await b.page.keyboard.press('Escape');
    await expect(undo).toBeHidden({ timeout: UI });
}

test('story 74 — Automate’s four tabs, and undo on the bar', async ({ browser, world },
    testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    await test.step('1 — Automate opens on his flows, and one opens into the Editor',
        () => theFlowsPage(b));
    await test.step('2 — a change is undone and redone from the top bar',
        () => undoneFromTheBar(b));
    await test.step('3 — the Server control decides what the left column lists',
        () => theServerDecides(b));
    await test.step('4 — Schedule is the chosen server’s Planner', () => theSchedule(b));
    await test.step('5 — Paths: a route drawn on his field, and a product on it',
        () => aRoute(b));
    await test.step('and he leaves Automate', () => leaves(b));
    await test.step('6 — in Terrain the same two glyphs undo the ground', () => theGround(b));
    await b.close();
});
