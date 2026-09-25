// Story 60 — the operator says what a kind is, and the pickers follow (EDT.23,
// PLAN-editors.md D4).
//
// A adds a `hedge` kind, drawn as a line, a metre and a half wide and
// straight between its posts, and hides `aerialway` from the pickers. When B
// opens Build → Lines, a hedge is one of the things he can draw, and says how
// wide it is; a cable car is not on offer.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { ben, linesOnHisLand } from './editors.js';

test.setTimeout(600_000);

async function addsAHedge(a) {
    await panel(a, 'Vocabulary');
    await a.page.locator('.ad-newkind').click();
    await a.page.locator('.vo-new-name').fill('hedge');
    await a.page.locator('.vo-new-geom').selectOption('line');
    await a.page.locator('.vo-new button[type="submit"]').click();
    await expect(a.page.locator('.ad-status')).toContainText('hedge is a thing the world can hold',
        { timeout: UI });
    await expect(a.page.locator('.vo-name')).toHaveValue('hedge');
    await a.page.locator('.vo-width').fill('1.5');
    await a.page.locator('.vo-corner').selectOption('cornered');
    await a.page.locator('.vo-save-kind').click();
    await expect(a.page.locator('.ad-status')).toHaveText('hedge saved', { timeout: UI });
}

async function hidesAerialways(a) {
    await a.page.locator('.vo-row[data-kind="aerialway"] .vo-kind').click();
    await expect(a.page.locator('.vo-name')).toHaveValue('aerialway', { timeout: UI });
    // Blank is the editors' own guess, shown as the placeholder.
    await expect(a.page.locator('.vo-width')).toHaveValue('');
    await a.page.locator('.vo-hidden').check();
    await a.page.locator('.vo-save-kind').click();
    await expect(a.page.locator('.ad-status')).toHaveText('aerialway saved', { timeout: UI });
}

test('story 60 — a hedge the operator added is in Lines; a hidden kind is not',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        await signIn(a, 'anna@visp.example', 'Anna');
        await test.step('A adds a hedge, 1.5 m and cornered', () => addsAHedge(a));
        await test.step('A hides aerialways from the pickers', () => hidesAerialways(a));
        const b = await ben(browser, world, testInfo);
        await test.step('B finds the hedge in Lines, and no aerialway', async () => {
            await linesOnHisLand(b);
            const hedge = b.page.locator('.ln-kinds .kp-kind[data-kind="hedge"]');
            await b.page.locator('.ln-kinds .kp-search').fill('hedge');
            await expect(hedge).toBeVisible({ timeout: UI });
            await expect(hedge).toContainText('1.5 m wide');
            await b.page.locator('.ln-kinds .kp-search').fill('aerialway');
            await expect(b.page.locator('.ln-kinds .kp-kind[data-kind^="aerialway"]'))
                .toHaveCount(0);
            const corner = await b.page.evaluate(() => window.splatworld.lines.state.entries
                .find((e) => e.id === 'hedge')?.corner);
            expect(corner, 'a hedge runs straight between its posts').toBe(true);
        });
        await b.close();
        await a.close();
    });
