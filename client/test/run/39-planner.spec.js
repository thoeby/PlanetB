// Story 39 — the Planner: alpha's jobs on a timeline.
//
// B makes a second job on alpha, "Broken", that runs story 38's Lamp at dusk
// without being told where the world is, runs it, and runs story 36's Dusk
// twice more. The Planner has a lane for each: Dusk's runs done and its next
// run at six, Broken's run failed — opened, it says what alpha said. Choosing
// Dusk draws how long each of its runs took. "Failed only" leaves only the
// failure; Run now from the failure's card runs it again.

import { test, expect, open, signIn, UI } from './players.js';
import { chooseServer, openAutomate } from './automate.js';

const job = (b, name) => b.page.locator(`#flows li[data-job="${name}"]`);
const lane = (b, name) => b.page.locator(`#flows .pl-row[data-job="${name}"]`);

async function makesBroken(b) {
    await b.page.getByRole('button', { name: 'New job' }).click();
    const dialog = b.page.locator('#flows .fl-job-dialog');
    await dialog.getByLabel('Job name').fill('Broken');
    await dialog.getByLabel('Process').selectOption({ label: 'Lamp at dusk' });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(job(b, 'Broken')).toContainText('manual', { timeout: UI });
}

async function runs(b, name, times) {
    for (let i = 0; i < times; i++) {
        await job(b, name).getByRole('button', { name: 'Run now' }).click();
        await expect(b.page.locator('#flows .fl-mid .fl-run')).toContainText(`${name} on alpha`,
            { timeout: UI });
    }
}

test('story 39 — the Planner', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in and looks at alpha', async () => {
        await signIn(b, 'ben@visp.example', 'Ben');
        await openAutomate(b);
        await chooseServer(b, 'alpha');
        await b.page.locator('#flows .fl-tab', { hasText: 'On alpha' }).click();
    });
    await test.step('B makes Broken and runs it, and runs Dusk twice', async () => {
        await makesBroken(b);
        await runs(b, 'Broken', 1);
        await runs(b, 'Dusk', 2);
    });

    const planner = b.page.locator('#flows .fl-planner');
    await test.step('1 — the Planner has a lane a job', async () => {
        await b.page.getByRole('button', { name: 'Planner' }).click();
        await expect(planner).toBeVisible({ timeout: UI });
        await expect(planner.locator('.pl-count')).toHaveText('· 2 jobs on alpha');
        await expect(lane(b, 'Dusk').locator('.pl-run[data-status="done"]')).toHaveCount(3,
            { timeout: UI });
        await expect(lane(b, 'Dusk').locator('.pl-next')).toContainText('18:00');
        await expect(lane(b, 'Dusk').locator('.pl-next')).toContainText('3 runs · 0 failed');
        await expect(lane(b, 'Broken').locator('.pl-run[data-status="failed"]')).toHaveCount(1);
    });

    await test.step('2 — the failed run, opened, says what alpha said', async () => {
        await lane(b, 'Broken').locator('.pl-run').click();
        const pop = planner.locator('.pl-pop');
        await expect(pop).toBeVisible();
        await expect(pop.locator('.pl-badge')).toHaveText('failed');
        await expect(pop).toContainText('started by');
        await expect(pop).toContainText('alpha said', { timeout: UI });
        await pop.getByRole('button', { name: 'Close' }).click();
    });

    await test.step('3 — choosing Dusk draws how long its runs took', async () => {
        await lane(b, 'Dusk').locator('.pl-name').click();
        const chart = planner.locator('.pl-chart');
        await expect(chart.locator('.pl-chart-title')).toContainText('Dusk');
        await expect(chart.locator('.pl-bar')).toHaveCount(3);
        await expect(chart.locator('.pl-chart-numbers')).toContainText('failed 0');
        await chart.locator('.pl-bar').first().hover();
        await expect(chart.locator('.pl-tip')).toContainText('took');
    });

    await test.step('4 — Failed only leaves the failure; Run now runs it again', async () => {
        await planner.getByRole('button', { name: 'Failed only' }).click();
        await expect(lane(b, 'Dusk').locator('.pl-run')).toHaveCount(0);
        await lane(b, 'Broken').locator('.pl-run').click();
        await planner.locator('.pl-pop').getByRole('button', { name: 'Run now' }).click();
        await expect(lane(b, 'Broken').locator('.pl-run[data-status="failed"]')).toHaveCount(2,
            { timeout: UI });
        await planner.getByRole('button', { name: '7 days' }).click();
        await expect(planner.locator('.pl-tick')).toHaveCount(7);
        await planner.getByRole('button', { name: 'Close' }).last().click();
        await expect(planner).toBeHidden();
    });
    await b.close();
});
