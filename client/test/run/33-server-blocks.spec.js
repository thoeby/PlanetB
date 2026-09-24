// Story 33 — blocks come from the chosen server (TASKS-flows.md FL.2).
//
// alpha offers a plugin the bundle does not have (fixtures/weather.xml). B
// finds its block by search, with the palette saying where it came from, puts
// it into a flow on their land and saves. On beta, which lacks that plugin, the
// block is drawn hatched and the inspector says which server has no what; the
// palette no longer offers it; and the flow is still saved as it was.

import { test, expect, open, signIn, UI } from './players.js';
import { chooseServer, dragIn, newFlow, nodeNames, openAutomate, saves, selectBlock }
    from './automate.js';

test('story 33 — the palette has the chosen server’s blocks',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in and opens Automate on alpha', async () => {
            await signIn(b, 'ben@visp.example', 'Ben');
            await openAutomate(b);
            await chooseServer(b, 'alpha');
        });

        const palette = b.page.locator('#flows .fl-palette');
        await test.step('alpha’s own block is in the palette, and says so', async () => {
            await palette.locator('input').fill('forecast');
            await expect(palette.locator('li', { hasText: 'Forecast Tomorrow' }))
                .toContainText('from alpha', { timeout: UI });
        });

        await test.step('B puts it into a flow on their land and saves', async () => {
            await newFlow(b, 'Ben’s field', 'Weather check');
            await dragIn(b, 'forecast', 'Forecast Tomorrow');
            await expect.poll(() => nodeNames(b), { timeout: UI }).toContain('Forecast Tomorrow');
            await saves(b);
        });

        await test.step('on beta the block is hatched, and the page says why', async () => {
            await chooseServer(b, 'beta');
            await selectBlock(b, 'Forecast Tomorrow');
            await expect(b.page.locator('#flows .fl-missing'))
                .toHaveText('beta has no weather', { timeout: UI });
            await palette.locator('input').fill('forecast');
            await expect(palette).toContainText('No block of that name.', { timeout: UI });
            // Nothing about the flow changed by looking at it elsewhere.
            await expect(b.page.locator('#flows .fl-dirty')).toBeHidden();
        });

        await test.step('Refresh blocks asks again, and back on alpha it is whole', async () => {
            await chooseServer(b, 'alpha');
            await palette.getByRole('button', { name: 'Refresh blocks' }).click();
            await expect(b.page.locator('#flows .fl-said'))
                .toContainText('plugins from alpha', { timeout: UI });
            await selectBlock(b, 'Forecast Tomorrow');
            await expect(b.page.locator('#flows .fl-missing')).toHaveCount(0, { timeout: UI });
        });
        // Every window is a 3D view competing for one machine (story 30).
        await b.close();
    });
