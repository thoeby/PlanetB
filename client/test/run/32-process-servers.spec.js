// Story 32 — my process servers (TASKS-flows.md FL.1).
//
// B keeps two process servers, alpha and beta, and switches between them in
// Automate without the page reloading. One of them stops answering and the bar
// says so in words; the choice survives a reload; and C, who is somebody else,
// sees none of B's servers.
//
// The servers are tools/elx-fixture.py (client/test/run/elx.js). What passed
// here has passed against the fixture only.

import { test, expect, open, panelApp, signIn, UI } from './players.js';

const bar = (p) => p.page.locator('#flows .fl-top');
const serverSelect = (p) => p.page.getByLabel('Server', { exact: true });
const dot = (p) => p.page.locator('#flows .fl-srv .fl-dot');

async function addServer(b, name, url) {
    await serverSelect(b).selectOption({ label: 'Add a server…' });
    const dialog = b.page.locator('#flows .fl-srv-dialog');
    await expect(dialog).toBeVisible({ timeout: UI });
    await dialog.getByLabel('Server name').fill(name);
    await dialog.getByLabel('Server address').fill(url);
    await dialog.getByRole('button', { name: 'Test' }).click();
    await expect(dialog.locator('.fl-srv-answer')).toContainText('Answered', { timeout: UI });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden({ timeout: UI });
    await expect(serverSelect(b).locator('option:checked')).toHaveText(name, { timeout: UI });
}

async function bothAnswer(b, world) {
    await test.step('B adds alpha and beta, and both answer', async () => {
        await addServer(b, 'alpha', world.elx.alpha.url);
        await expect(dot(b)).toHaveAttribute('data-state', 'up', { timeout: UI });
        await expect(bar(b)).toContainText('fixture-1 (alpha)');
        await addServer(b, 'beta', world.elx.beta.url);
        await expect(dot(b)).toHaveAttribute('data-state', 'up', { timeout: UI });
        await expect(bar(b)).toContainText('fixture-1 (beta)');

        await serverSelect(b).selectOption({ label: 'Manage servers…' });
        const dialog = b.page.locator('#flows .fl-srv-dialog');
        for (const name of ['alpha', 'beta']) {
            await expect(dialog.locator(`li[data-server="${name}"] .fl-dot`))
                .toHaveAttribute('data-state', 'up', { timeout: UI });
        }
        await dialog.getByRole('button', { name: 'Done' }).click();
    });
}

async function sameNameRefused(b) {
    await test.step('a second server by the same name is refused in words', async () => {
        await serverSelect(b).selectOption({ label: 'Add a server…' });
        const dialog = b.page.locator('#flows .fl-srv-dialog');
        await dialog.getByLabel('Server name').fill('alpha');
        await dialog.getByLabel('Server address').fill('http://127.0.0.1:1');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog.locator('.fl-err'))
            .toHaveText('You already have a server called alpha.', { timeout: UI });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
    });
}

test('story 32 — a player keeps process servers and switches between them',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in and opens Automate', async () => {
            await signIn(b, 'ben@visp.example', 'Ben');
            await panelApp(b, 'Automate');
            await expect(bar(b)).toBeVisible({ timeout: UI });
        });

        await bothAnswer(b, world);
        await sameNameRefused(b);

        await test.step('beta stops, and the bar says so', async () => {
            world.elx.beta.stop();
            await expect(dot(b)).toHaveAttribute('data-state', 'down', { timeout: UI });
            await expect(bar(b)).toContainText('That address did not answer.');
        });

        await test.step('B switches to alpha without a reload, and it is kept', async () => {
            const marker = await b.page.evaluate(() => { window.__notReloaded = 1; return 1; });
            await serverSelect(b).selectOption({ label: 'alpha' });
            await expect(dot(b)).toHaveAttribute('data-state', 'up', { timeout: UI });
            expect(await b.page.evaluate(() => window.__notReloaded), 'no reload').toBe(marker);

            await b.page.reload();
            await panelApp(b, 'Automate');
            await expect(serverSelect(b).locator('option:checked')).toHaveText('alpha',
                { timeout: UI });
        });

        await test.step('C sees none of B’s servers', async () => {
            const c = await open(browser, world, 'C', testInfo);
            await signIn(c, 'cara@visp.example', 'Cara');
            await panelApp(c, 'Automate');
            await expect(bar(c)).toBeVisible({ timeout: UI });
            const labels = await serverSelect(c).locator('option').allTextContents();
            expect(labels).not.toContain('alpha');
            expect(labels).not.toContain('beta');
            await c.close();
        });

        await world.elx.beta.start();
        // Every window is a 3D view competing for one machine (story 30).
        await b.close();
    });
