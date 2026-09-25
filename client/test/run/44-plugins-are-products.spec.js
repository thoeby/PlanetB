// Story 44 — plugins and flows are products (TASKS-live.md LV.7).
//
// C registers the `motion` plugin — its folder, as the tar a person packs a
// folder into — in the catalog. B, a second player, finds it, buys it (free:
// nobody in this world has earned anything to pay with) and installs it on
// his own server, beta, which had no motion blocks. In Automate on beta the
// Motion blocks now say they come from beta.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { test, expect, open, panel, signIn, UI } from './players.js';
import { chooseServer, openAutomate } from './automate.js';
import { REPO } from './world.js';
import { writeTar } from '../../lib/tar.js';

// What C is given: the plugin folder, packed as anybody packs a folder —
// under its own name, in whatever order the disk lists it.
function givenTar() {
    const root = join(REPO, 'client/flow/motion');
    const entries = [{ name: 'motion/plugin.xml', bytes: readFileSync(join(root, 'plugin.xml')) }];
    for (const f of readdirSync(join(root, 'assets/nodes')).reverse()) {
        entries.push({ name: `motion/assets/nodes/${f}`,
            bytes: readFileSync(join(root, 'assets/nodes', f)) });
    }
    const file = join(REPO, 'test-results/run/given/motion.tar');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, writeTar(entries));
    return file;
}

async function registersThePlugin(c, file) {
    await panel(c, 'Catalog');
    await c.page.locator('#upload-type').selectOption('plugin');
    await c.page.locator('#product-file').setInputFiles(file);
    await expect(c.page.locator('#product-said')).toHaveText('plugin motion · 6 blocks',
        { timeout: UI });
    await c.page.locator('#name').fill('Motion');
    await c.page.locator('#upload-license').selectOption('free');
    await c.page.locator('#publish').click();
    await expect(c.page.locator('#upload-status')).toContainText('published S', { timeout: UI });
}

const motionLine = (b) => b.page.locator('#flows .fl-palette li', { hasText: 'Move To' }).first();

async function looksForMoveTo(b) {
    await b.page.locator('#flows .fl-palette input').fill('Move To');
    await expect(motionLine(b)).toBeVisible({ timeout: UI });
}

async function buysAndInstalls(b) {
    await panel(b, 'Catalog');
    await b.page.locator('#type').selectOption('plugin');
    await b.page.locator('#q').fill('Motion');
    await b.page.getByRole('button', { name: 'Find' }).click();
    const card = b.page.locator('#results li', { hasText: 'Motion' }).first();
    await expect(card).toBeVisible({ timeout: UI });
    await card.getByRole('button', { name: 'Motion' }).click();
    const detail = b.page.locator('#detail');
    await expect(detail).toContainText('Bought once: you keep this version', { timeout: UI });
    await detail.locator('button.buy').click();
    await expect(b.page.locator('#status')).toContainText('licensed S', { timeout: UI });
    const row = detail.locator('.install-row');
    await expect(row).toBeVisible({ timeout: UI });
    await row.getByLabel('install on').selectOption({ label: 'beta' });
    await row.getByRole('button', { name: 'Install' }).click();
    await expect(row.locator('.install-said')).toHaveText('Motion is on beta', { timeout: UI });
}

test('story 44 — the motion plugin is bought and lands on the buyer’s server',
    async ({ browser, world }, testInfo) => {
        const file = givenTar();
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('1 — C registers the motion plugin', () => registersThePlugin(c, file));
        await c.close();

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await test.step('2 — on beta, Move To is only the bundle’s', async () => {
            await openAutomate(b);
            await chooseServer(b, 'beta');
            await looksForMoveTo(b);
            await expect(motionLine(b)).not.toContainText('from beta');
            // Nothing was drawn; whatever the empty canvas thinks it holds is
            // not kept.
            await b.page.locator('#flows .fl-close').click();
            const box = b.page.locator('#flows .fl-ask');
            if (await box.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
                await box.getByRole('button', { name: 'Discard' }).click();
            }
            await expect(b.page.locator('#flows')).toBeHidden({ timeout: UI });
        });
        await test.step('3 — B buys it and installs it on beta', () => buysAndInstalls(b));
        await test.step('4 — and on beta, Move To is beta’s now', async () => {
            await openAutomate(b);
            await chooseServer(b, 'beta');
            await b.page.getByRole('button', { name: 'Refresh blocks' }).click();
            await looksForMoveTo(b);
            await expect(motionLine(b)).toContainText('from beta', { timeout: UI });
        });
        await b.close();
    });
