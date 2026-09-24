// Story 34 — processes on a server (TASKS-flows.md FL.3).
//
// B sends the flow from story 33 to alpha and finds it there; opens it as it is
// on the server, where it cannot be changed; duplicates it and deletes the
// copy; sends it again and is asked before anything is sent over; and saves
// alpha's own sample into their land, which then exports byte for byte as
// alpha returned it.

import { readFileSync } from 'node:fs';
import { test, expect, open, signIn, UI } from './players.js';
import { chooseServer, openAutomate, said } from './automate.js';
import { SAMPLE } from './elx.js';

const onServer = (p) => p.page.locator('#flows .fl-pane:not([hidden])');
const processRow = (p, name) =>
    p.page.locator(`#flows li[data-process="${name}"]`);

async function openMine(b, name) {
    await b.page.locator('#flows .fl-tab', { hasText: 'My flows' }).click();
    await b.page.locator('#flows .fl-list li[data-flow] .pick', { hasText: name }).first().click();
    await expect(b.page.locator('#flows .fl-top .name')).toHaveText(name, { timeout: UI });
}

async function sendsIt(b) {
    await test.step('B sends Weather check to alpha, and it is there', async () => {
        await openMine(b, 'Weather check');
        await b.page.getByRole('button', { name: 'Send to alpha' }).click();
        await expect(said(b)).toHaveText('sent Weather check to alpha', { timeout: UI });
        await b.page.locator('#flows .fl-tab', { hasText: 'On alpha' }).click();
        await expect(processRow(b, 'Weather check')).toBeVisible({ timeout: UI });
    });
}

async function looksAtIt(b) {
    await test.step('opened from alpha, it is alpha’s and cannot be saved here', async () => {
        await processRow(b, 'Weather check').getByRole('button', { name: 'Open' }).click();
        await expect(b.page.locator('#flows .fl-top .name'))
            .toHaveText('Weather check · on alpha', { timeout: UI });
        await expect(b.page.locator('#flows .fl-save')).toBeDisabled();
    });
}

async function copiesAndDeletes(b) {
    await test.step('B duplicates it on alpha and deletes the copy', async () => {
        await processRow(b, 'Weather check').getByRole('button', { name: 'Dup' }).click();
        const copy = processRow(b, 'Copy of Weather check');
        await expect(copy).toBeVisible({ timeout: UI });
        await copy.getByRole('button', { name: 'Del' }).click();
        const box = b.page.locator('#flows .fl-ask');
        await expect(box).toContainText('Jobs that run it stop working.');
        await box.locator('input').fill('Copy of Weather check');
        await box.getByRole('button', { name: 'Delete' }).click();
        await expect(copy).toHaveCount(0, { timeout: UI });
    });
}

async function sendsAgain(b) {
    await test.step('sending again asks before sending over it', async () => {
        await openMine(b, 'Weather check');
        await b.page.getByRole('button', { name: 'Send to alpha' }).click();
        const box = b.page.locator('#flows .fl-ask');
        await expect(box).toContainText('alpha already has a process called Weather check.',
            { timeout: UI });
        await box.getByRole('button', { name: 'Send' }).click();
        await expect(said(b)).toHaveText('sent Weather check to alpha', { timeout: UI });
        await b.page.locator('#flows .fl-tab', { hasText: 'On alpha' }).click();
        await expect(processRow(b, 'Weather check')).toHaveCount(1);
    });
}

async function keepsTheSample(b) {
    await test.step('alpha’s sample, saved into B’s land, exports as it came', async () => {
        await processRow(b, 'file-response')
            .getByRole('button', { name: 'Save into my land…' }).click();
        const box = b.page.locator('#flows .fl-ask');
        await box.locator('select').selectOption({ label: 'Ben’s field' });
        await box.getByRole('button', { name: 'Save' }).click();
        await expect(said(b)).toHaveText('imported file-response', { timeout: UI });
        await expect(b.page.locator('#flows .fl-top .name')).toHaveText('file-response');
        const [file] = await Promise.all([
            b.page.waitForEvent('download'),
            b.page.locator('#flows .fl-export').click(),
        ]);
        const got = readFileSync(await file.path(), 'utf8');
        expect(got === readFileSync(SAMPLE, 'utf8'), 'byte for byte as alpha had it').toBe(true);
    });
}

test('story 34 — processes on a server', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs in and opens Automate on alpha', async () => {
        await signIn(b, 'ben@visp.example', 'Ben');
        await openAutomate(b);
        await chooseServer(b, 'alpha');
        await expect(onServer(b)).toBeVisible();
    });
    await sendsIt(b);
    await looksAtIt(b);
    await copiesAndDeletes(b);
    await sendsAgain(b);
    await b.page.locator('#flows .fl-tab', { hasText: 'On alpha' }).click();
    await keepsTheSample(b);
    // Every window is a 3D view competing for one machine (story 30).
    await b.close();
});
