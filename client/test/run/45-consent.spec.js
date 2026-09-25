// Story 45 — flows declare what they need, and owners consent
// (TASKS-live.md LV.8 and LV.9).
//
// C keeps a product as a folder — the barrier model, its product.json and its
// flow — and puts it in the world with the registrar, from her own machine
// with her own login. B buys it and puts one on his field. C then registers a
// fix whose flow also asks to pay up to 5 a day: B's barrier stays on the
// version it had, the Place panel says what the new one asks, and it moves
// only when B presses Allow.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, looking, open, panel, signIn, PASSWORD, UI } from './players.js';
import { footOf } from './automate.js';
import { goesToTheLand, plants, stands } from './things.js';
import { REPO } from './world.js';

const FOLDER = join(REPO, 'test-results/run/given/barrier');
const FLOW = join(REPO, 'client/flow/samples/file-response.elx');

function theFolder(product, flowTail = '') {
    mkdirSync(FOLDER, { recursive: true });
    copyFileSync(join(REPO, 'client/test/fixtures/assets/gate.glb'), join(FOLDER, 'model.glb'));
    writeFileSync(join(FOLDER, 'flow.elx'), readFileSync(FLOW, 'utf8') + flowTail);
    writeFileSync(join(FOLDER, 'product.json'), JSON.stringify(product, null, 2));
}

// C, at her own machine: the registrar, with her login.
function cRegisters(world) {
    const done = spawnSync('python3', [join(REPO, 'tools/register.py'), FOLDER,
        '--api', world.apiUrl, '--files', world.filesUrl], { encoding: 'utf8',
        env: { ...process.env, SPLATWORLD_EMAIL: 'cara@visp.example',
            SPLATWORLD_PASSWORD: PASSWORD } });
    expect(done.status, `the registrar said: ${done.stderr}`).toBe(0);
    return done.stdout.trim();
}

const version = (b) => b.page.locator('.build-update');

async function buysIt(b) {
    await panel(b, 'Shop');
    await b.page.locator('#type').selectOption('');
    await b.page.locator('#q').fill('Barrier');
    await b.page.getByRole('button', { name: 'Find' }).click();
    const card = b.page.locator('#results li', { hasText: 'Barrier' }).first();
    await expect(card).toBeVisible({ timeout: UI });
    await card.getByRole('button', { name: 'Barrier' }).click();
    await b.page.locator('#detail button.buy').click();
    await expect(b.page.locator('#status')).toContainText('licensed S', { timeout: UI });
}

async function looksAgain(b, barrier) {
    // Back another time: the panel reads the thing's version when it is
    // selected.
    await b.page.reload();
    await looking(b);
    await panel(b, 'Place');
    await b.page.locator('.build-toggle').check();
    await expect.poll(() => footOf(b, barrier), { timeout: UI }).not.toBeNull();
    const at = await footOf(b, barrier);
    await b.page.mouse.click(at.x, at.y);
    await expect(b.page.locator('.build-update-section')).toBeVisible({ timeout: UI });
}

test('story 45 — a fix that asks to pay waits for the owner’s Allow',
    async ({ browser, world }, testInfo) => {
        rmSync(FOLDER, { recursive: true, force: true });
        const product = { name: 'Barrier', category: 'prop', licence: 'cc0', price: 0,
            policy: 'once', channel: 'current', needs: { ports: 'own' },
            marks: { parts: [{ name: 'bar', node: 'bar', role: 'joint' }],
                ports: [{ name: 'pose', type: 'pose', default: '',
                    drives: { part: 'bar', what: 'pose' } }] } };
        const first = await test.step('1 — C registers the barrier from its folder', () => {
            theFolder(product);
            return cRegisters(world);
        });
        const oldFlow = first.match(/flow ([0-9a-f]{12})/)[1];

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const barrier = await test.step('2 — B buys it and puts one on his field', async () => {
            await buysIt(b);
            const here = await goesToTheLand(b);
            await stands(b, world, here, 0.00108, -0.0002);
            const id = await plants(b, 'Barrier');
            await expect(version(b)).toContainText(`with flow ${oldFlow}`, { timeout: UI });
            return id;
        });

        const fix = await test.step('3 — C registers a fix that also asks to pay', () => {
            theFolder({ ...product, fix: true,
                needs: { ports: 'own', pay: { max_per_day: 5 } } }, '<!-- fixed -->\n');
            return cRegisters(world);
        });
        const newFlow = fix.match(/flow ([0-9a-f]{12})/)[1];
        expect(newFlow).not.toBe(oldFlow);

        await test.step('4 — B’s barrier stays as it was, and says what the fix asks',
            async () => {
                await looksAgain(b, barrier);
                await expect(version(b)).toContainText(`with flow ${oldFlow}`, { timeout: UI });
                await expect(version(b)).toContainText('An update to Barrier asks to pay up to'
                    + ' 5 a day. It stays as it is until you allow it.');
            });
        await test.step('5 — B presses Allow, and it moves', async () => {
            await b.page.locator('.build-allow').click();
            await expect(b.page.locator('.build-update-said'))
                .toHaveText('Barrier runs its latest version.', { timeout: UI });
            await expect(version(b)).toContainText(`with flow ${newFlow}`);
            await expect(b.page.locator('.build-allow')).toHaveCount(0);
        });
        await b.close();
    });
