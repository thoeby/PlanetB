// Story 36 — jobs and reports on a server (TASKS-flows.md FL.5).
//
// B makes a job on alpha that runs the process sent in story 34 every evening,
// sees when it will next run and that a cron trigger checks at most once a
// minute, runs it now, reads what alpha said about the run, and finds that
// report again under Reports.

import { test, expect, open, signIn, UI } from './players.js';
import { chooseServer, openAutomate } from './automate.js';

const job = (b, name) => b.page.locator(`#flows li[data-job="${name}"]`);
const dialog = (b) => b.page.locator('#flows .fl-job-dialog');

test('story 36 — jobs and reports on a server', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in and looks at alpha', async () => {
        await signIn(b, 'ben@visp.example', 'Ben');
        await openAutomate(b);
        await chooseServer(b, 'alpha');
        await b.page.locator('#flows .fl-tab', { hasText: 'On alpha' }).click();
    });

    await test.step('B makes Dusk: Weather check, every evening at six', async () => {
        await b.page.getByRole('button', { name: 'New job' }).click();
        await dialog(b).getByLabel('Job name').fill('Dusk');
        await dialog(b).getByLabel('Process').selectOption({ label: 'Weather check' });
        await dialog(b).getByLabel('Trigger type').selectOption('cron');
        await dialog(b).getByRole('button', { name: 'Add trigger' }).click();
        await dialog(b).getByLabel('Expression').fill('0 18 * * *');
        await expect(dialog(b).locator('.fl-cron-next li')).toHaveCount(5);
        await expect(dialog(b).locator('.fl-cron-next li').first()).toContainText('18:00');
        await expect(dialog(b)).toContainText('A cron trigger checks at most once a minute.');
        await dialog(b).getByRole('button', { name: 'Save' }).click();
        await expect(job(b, 'Dusk')).toContainText('cron 0 18 * * *', { timeout: UI });
        await expect(job(b, 'Dusk')).toContainText('Weather check');
    });

    await test.step('a cron expression that is not one says so', async () => {
        await job(b, 'Dusk').getByRole('button', { name: 'Edit' }).click();
        await dialog(b).getByLabel('Expression').fill('every evening');
        await expect(dialog(b).locator('.fl-cron-next'))
            .toContainText('That is not a cron expression');
        await dialog(b).getByRole('button', { name: 'Cancel' }).click();
    });

    await test.step('Run now, and what alpha said about it', async () => {
        await job(b, 'Dusk').getByRole('button', { name: 'Run now' }).click();
        const run = b.page.locator('#flows .fl-mid .fl-run');
        await expect(run).toBeVisible({ timeout: UI });
        await expect(run).toContainText('Dusk on alpha');
        await expect(run).toContainText('done');
        await expect(run).toContainText('alpha does not stream runs');
        await expect(run.locator('.fl-tree')).toContainText('result_code');
    });

    await test.step('and the report is kept under Reports', async () => {
        const reports = b.page.locator('#flows details.fl-section', { hasText: 'Reports' });
        await reports.getByLabel('Reports of job').selectOption({ label: 'Dusk' });
        const rowOf = reports.locator('li[data-report]').first();
        await expect(rowOf).toContainText('Dusk', { timeout: UI });
        await expect(rowOf).toContainText('✓ 0');
        await rowOf.getByRole('button', { name: 'Open' }).click();
        await expect(b.page.locator('#flows .fl-mid .fl-run .fl-tree')).toContainText('Dusk');
    });
    // Every window is a 3D view competing for one machine (story 30).
    await b.close();
});
