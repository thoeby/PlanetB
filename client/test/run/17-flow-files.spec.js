// Story 17 — a flow is a file (TASKS-foundation.md FND.2, docs/SPEC.md §2.16).
//
// A imports the two flows a process server exported, gets them back byte for
// byte, and asks whether they would run. The asking has two halves: the process
// server, which this world may not have, and what the page can see for itself,
// which it always checks. Both are shown and neither hides the other.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, open, panel, panelApp, signIn, UI } from './players.js';
import { openAutomate } from './automate.js';

const SAMPLES = new URL('../../flow/samples/', import.meta.url).pathname;
const sampleNames = () => readdirSync(SAMPLES).filter((f) => f.endsWith('.elx'));
const sampleText = (name) => readFileSync(join(SAMPLES, name), 'utf8');

// The process server this world checks flows against, if the run was given one.
const ELX_URL = (process.env.ELX_URL ?? '').trim();

// A file arrives the way a file arrives: the player chooses one. The chooser
// itself belongs to the operating system and no test can press it, so the story
// hands the page's own file input what was chosen — which is exactly the event
// the chooser fires. `files` is a list of paths, or of the objects Playwright
// takes for a file that was never on disk.
async function imports(a, files, arrived) {
    await expect(a.page.locator('#flows .fl-import')).toBeVisible({ timeout: UI });
    await a.page.locator('#flows .fl-file').setInputFiles(files);
    // By the name of what arrived, not by the word: the bar still carries what
    // the last import said, and "imported" alone would match that.
    await expect(a.page.locator('#flows .fl-said'))
        .toContainText(`imported ${arrived}`, { timeout: UI });
}

// A flow with a wire the ports do not allow: Contains gives a boolean and
// Append takes a string. Drawing it is impossible — the canvas refuses the
// connection as it is made — but a file can hold it, and a file is what a
// process server sends. This is what the local check is for.
const BAD_WIRE = `<elx>
    <engine type="flow">
        <max_steps>0</max_steps>
        <record_history>false</record_history>
    </engine>
    <node id="contains" name="Is it there" plugin="strings"/>
    <node id="append" name="Add to it" plugin="strings"/>
    <net name="N001">
        <connection node="Is it there" port="contains"/>
        <connection node="Add to it" port="in"/>
    </net>
</elx>
`;

const listed = (a) => a.page.locator('#flows .fl-list li[data-flow] button.pick')
    .allTextContents();

// Export writes the file where the browser puts downloads; the story reads it
// back off disk, which is what "the bytes equal the originals" means.
async function exportOpen(a) {
    const [download] = await Promise.all([
        a.page.waitForEvent('download'),
        a.page.locator('#flows .fl-export').click(),
    ]);
    const path = await download.path();
    return { name: download.suggestedFilename(), text: readFileSync(path, 'utf8') };
}

async function opens(a, name) {
    // By name exactly: importing the same file twice makes "<name> 2" beside
    // it, and a substring match would open whichever came first.
    await a.page.locator('#flows .fl-list li[data-flow] button.pick')
        .filter({ hasText: new RegExp(`^${name}$`) }).first().click();
    await expect(a.page.locator('#flows .fl-top .name')).toHaveText(name, { timeout: UI });
}

// 1, 2 — both samples in, and out again unchanged.
async function inAndOut(a) {
    const names = sampleNames();
    await imports(a, names.map((n) => join(SAMPLES, n)),
        names.map((n) => n.replace('.elx', '')).join(', '));
    const shown = await listed(a);
    for (const n of names) {
        expect(shown, `${n} is on the land`).toContain(n.replace('.elx', ''));
    }
    // Laid out: an ELX carries no coordinates, so an imported flow that had
    // every block at the same place would be one black square.
    const spread = await a.page.evaluate(() => {
        const pos = (window.splatworld.flows.canvas().graph._nodes ?? []).map((n) => n.pos);
        return new Set(pos.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`)).size;
    });
    expect(spread, 'the blocks are not all in one place').toBeGreaterThan(2);

    for (const n of names) {
        await opens(a, n.replace('.elx', ''));
        const out = await exportOpen(a);
        expect(out.name).toBe(n);
        expect(out.text, `${n} came out as it went in`).toBe(sampleText(n));
    }
}

// 3 — a changed flow is not exported as something else.
async function saveFirst(a) {
    const name = sampleNames()[0].replace('.elx', '');
    await opens(a, name);
    const before = await a.page.evaluate(() => window.splatworld.flows.canvas().elx());
    await a.page.evaluate(() => window.splatworld.flows.canvas().relayout());
    await a.page.locator('#flows .fl-palette input').fill('strings contains');
    const line = a.page.locator('#flows .fl-palette li', { hasText: 'Contains' }).first();
    const from = await line.boundingBox();
    const box = await a.page.locator('#flows canvas.fl-canvas').boundingBox();
    await a.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await a.page.mouse.down();
    await a.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 10 });
    await a.page.mouse.up();
    await expect(a.page.locator('#flows .fl-dirty')).toBeVisible({ timeout: UI });

    await a.page.locator('#flows .fl-export').click();
    await expect(a.page.locator('#flows .fl-said')).toHaveText('save first', { timeout: UI });

    await a.page.locator('#flows .fl-save').click();
    await expect(a.page.locator('#flows .fl-said')).toHaveText('saved', { timeout: UI });
    const out = await exportOpen(a);
    expect(out.text, 'the export is the new file now').not.toBe(before);

    // And what came out goes back in: a flow this editor wrote is one it reads.
    await imports(a, [{ name: `${name}.elx`, mimeType: 'application/xml',
        buffer: Buffer.from(out.text) }], `${name} 2`);
    expect(await listed(a), 'the copy is beside it').toContain(`${name} 2`);
}

// 4, 5 — Validate: the page's own check always, the server's when there is one.
async function validates(a) {
    await opens(a, sampleNames()[0].replace('.elx', ''));
    await a.page.locator('#flows .fl-validate').click();
    const check = a.page.locator('#flows .fl-problems');
    await expect(check).toBeVisible({ timeout: UI });
    await expect(check).toContainText('Nothing wrong that this page can see');
    // The server half arrives after the local one, so this waits for it.
    const said = a.page.locator('#flows .fl-said');
    if (ELX_URL) {
        await expect(said, 'the process server said it would run this')
            .toContainText('valid', { timeout: UI });
    } else {
        await expect(said, 'and says plainly that nobody was asked')
            .toContainText('No process server is configured', { timeout: UI });
    }

    // A file with things wrong in it. The canvas would not let anybody draw
    // them; a file from elsewhere can hold them, which is why the check exists.
    await imports(a, [{ name: 'bad-wire.elx', mimeType: 'application/xml',
        buffer: Buffer.from(BAD_WIRE) }], 'bad-wire');
    await a.page.locator('#flows .fl-validate').click();
    await expect(a.page.locator('#flows .fl-said')).toContainText('problem(s) here',
        { timeout: UI });
    await expect(check).toContainText('cannot feed');
    await expect(check).toContainText('Add to it');
    const first = a.page.locator('#flows .fl-problem-list li[data-block]:not([data-block=""])')
        .first();
    await expect(first).toBeVisible({ timeout: UI });
    const named = await first.getAttribute('data-block');
    await first.locator('button').click();
    const selected = await a.page.evaluate(() =>
        window.splatworld.flows.canvas().selected()?._irName ?? null);
    expect(selected, 'pressing the problem went to the block it names').toBe(named);
}

test('story 17 — flows go out as files and come back as files',
    async ({ browser, world }, testInfo) => {
        test.skip(!existsSync(SAMPLES), 'no sample flows to import');
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in', () => signIn(a, 'anna@visp.example', 'Anna'));

        if (!ELX_URL) {
            testInfo.annotations.push({ type: 'note',
                text: 'ELX_URL not set: the process server half of Validate is'
                    + ' unrun here, and the story checks what the page says about that.' });
        } else {
            await test.step('A points the world at a process server', async () => {
                await panelApp(a, 'Build');
                await panel(a, 'Setup');
                await a.page.locator('.gs-elx').fill(ELX_URL);
                await a.page.locator('.gs-elx-save').click();
                await expect(a.page.locator('.gs-elx-status'))
                    .toContainText('checked against', { timeout: UI });
            });
        }

        await test.step('1, 2 — both samples in, and out byte for byte', async () => {
            await openAutomate(a);
            await expect(a.page.locator('#flows')).toBeVisible({ timeout: UI });
            await inAndOut(a);
        });
        await test.step('3 — a changed flow is asked to be saved first',
            () => saveFirst(a));
        await test.step('4, 5 — Validate says both halves', () => validates(a));

        await test.step('and the view closes', async () => {
            await panelApp(a, 'Build');
            const box = a.page.locator('#flows .fl-ask');
            if (await box.isVisible()) {
                await box.getByRole('button', { name: 'Discard' }).click();
            }
            await expect(a.page.locator('#flows')).toBeHidden({ timeout: UI });
        });

        // A window nobody closed is a WebGL context nobody gave back, and the
        // next story opens two of its own.
        await a.close();
    });
