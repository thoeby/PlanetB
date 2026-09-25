// Story 55 — B's lines, listed, named and taken away (EDT.18,
// PLAN-editors.md ideas 26, 27 and 31).
//
// The panel lists the land's lines with their kind, length and steepest
// climb. Clicking one selects it and shows its fields — a name and its kind's
// own properties from the vocabulary. He names one, deletes the other, saves,
// and the world holds exactly that. (The neighbours' ghosts need a
// neighbour, which this run's world has not got; linesnap aroundLand reads
// them and only his own lines are ever hit.)

import { test, expect, UI } from './players.js';
import { ben, linesInTheWorld, linesOnHisLand, shot } from './editors.js';

test.setTimeout(600_000);

test('story 55 — the list, a rename and a delete, saved',
    async ({ browser, world }, testInfo) => {
        const b = await ben(browser, world, testInfo);
        await linesOnHisLand(b);
        // The land's lines are a card off the toolbar, folded until asked for.
        await b.page.locator('.ln-list-toggle').click();
        const rows = b.page.locator('.ln-list .ln-row');
        await test.step('two lines listed with kind, length and climb', async () => {
            await expect(rows).toHaveCount(2, { timeout: UI });
            await expect(rows.first()).toContainText('highway · residential');
            await expect(rows.first()).toContainText(/\d+ m · \d+ %/);
        });
        await test.step('selected: its fields are the vocabulary’s', async () => {
            await rows.first().click();
            await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
            await expect(b.page.locator('.ln-selected')).toBeVisible();
            await expect(b.page.locator('.ln-field-surface')).toBeVisible();
            await expect(b.page.locator('.ln-field-lanes')).toBeVisible();
            await b.page.locator('.ln-field-name').fill('Upper lane');
            await b.page.locator('.ln-field-name').dispatchEvent('change');
            await expect(rows.first()).toContainText('Upper lane');
            await shot(b, testInfo, 'story-55-panel');
        });
        await test.step('the other deleted, both saved', async () => {
            await rows.nth(1).click();
            await b.page.locator('.ln-delete').click();
            await expect(rows).toHaveCount(1);
            await b.page.locator('.ln-save').click();
            await expect(b.page.locator('.ln-status')).toHaveText('2 lines saved', { timeout: UI });
            const got = await linesInTheWorld(b);
            expect(got).toHaveLength(1);
            expect(got[0].props.name).toBe('Upper lane');
        });
        await b.close();
    });
