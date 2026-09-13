// Story 6 — submitting for approval (docs/SPEC.md §3.5).
//
// B has drawn a wood and put two benches on their land. They submit it: the
// dialog says what is being sent before anything leaves, and afterwards the
// tile says it is awaiting approval.

import { test, expect, open, panel, signIn, UI } from './players.js';

test('story 6 — B submits what they built, and the tile says so',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        await test.step('the Submit panel says what is about to be sent', async () => {
            await panel(b, 'Submit');
            await expect(b.page.locator('.su-changes'))
                .toContainText(/\d+ tiles?/, { timeout: UI });
            // What the approver will see: the objects and what was drawn.
            await expect(b.page.locator('.su-changes')).toContainText('object');
            await expect(b.page.locator('.su-send')).toBeEnabled();
        });

        await test.step('B sends it with a note', async () => {
            await b.page.locator('.su-note').fill('the benches by the path');
            await b.page.locator('.su-send').click();
            await expect(b.page.locator('.su-status'))
                .toContainText('awaiting approval', { timeout: UI });
        });

        await test.step('and there is nothing left to submit', async () => {
            await expect(b.page.locator('.su-send'))
                .toHaveText('Nothing to submit', { timeout: UI });
            await expect(b.page.locator('.su-send')).toBeDisabled();
        });

        await test.step('the land says it is waiting for a decision', async () => {
            await panel(b, 'Your land');
            await expect(b.page.locator('.land-awaiting'))
                .toContainText('awaiting approval', { timeout: UI });
            await expect(b.page.locator('.land-changed')).toHaveCount(0);
        });

        await b.close();
    });
