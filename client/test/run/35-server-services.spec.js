// Story 35 — services on a server (TASKS-flows.md FL.4).
//
// B makes an HTTP server on port 8082 on alpha, from the kinds alpha's own
// plugins provide; changes its port; finds the change still there after a
// reload; and deletes it.

import { test, expect, open, signIn, UI } from './players.js';
import { chooseServer, openAutomate } from './automate.js';

const row = (b, name) => b.page.locator(`#flows li[data-service="${name}"]`);
const dialog = (b) => b.page.locator('#flows .fl-svc-dialog');

async function onAlpha(b) {
    await openAutomate(b);
    await chooseServer(b, 'alpha');
}

test('story 35 — services on a server', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in and looks at alpha', async () => {
        await signIn(b, 'ben@visp.example', 'Ben');
        await onAlpha(b);
    });

    await test.step('B makes an HTTP server on port 8082', async () => {
        await b.page.getByRole('button', { name: 'New service' }).click();
        await dialog(b).getByLabel('Service type').selectOption('http::server');
        await dialog(b).getByLabel('Service name').fill('Web on 8082');
        await dialog(b).getByLabel('Port').fill('8082');
        await dialog(b).getByRole('button', { name: 'Save' }).click();
        await expect(row(b, 'Web on 8082')).toContainText('http::server', { timeout: UI });
    });

    await test.step('a second one by that name is refused in words', async () => {
        await b.page.getByRole('button', { name: 'New service' }).click();
        await dialog(b).getByLabel('Service type').selectOption('http::server');
        await dialog(b).getByLabel('Service name').fill('Web on 8082');
        await dialog(b).getByRole('button', { name: 'Save' }).click();
        await expect(dialog(b).locator('.fl-err'))
            .toHaveText('alpha already has a service called Web on 8082.', { timeout: UI });
        await dialog(b).getByRole('button', { name: 'Cancel' }).click();
    });

    await test.step('B changes the port, and it stays changed', async () => {
        await row(b, 'Web on 8082').getByRole('button', { name: 'Edit' }).click();
        await dialog(b).getByLabel('Port').fill('8083');
        await dialog(b).getByRole('button', { name: 'Save' }).click();
        await expect(dialog(b)).toBeHidden({ timeout: UI });
        await b.page.reload();
        await onAlpha(b);
        await row(b, 'Web on 8082').getByRole('button', { name: 'Edit' }).click();
        await expect(dialog(b).getByLabel('Port')).toHaveValue('8083', { timeout: UI });
        await dialog(b).getByRole('button', { name: 'Cancel' }).click();
    });

    await test.step('B deletes it', async () => {
        await row(b, 'Web on 8082').getByRole('button', { name: 'Del' }).click();
        const box = b.page.locator('#flows .fl-ask').last();
        await expect(box).toContainText('Jobs and triggers that use it stop working.');
        await box.locator('input').fill('Web on 8082');
        await box.getByRole('button', { name: 'Delete' }).click();
        await expect(row(b, 'Web on 8082')).toHaveCount(0, { timeout: UI });
    });
    // Every window is a 3D view competing for one machine (story 30).
    await b.close();
});
