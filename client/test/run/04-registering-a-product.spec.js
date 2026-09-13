// Story 4 — registering a product (docs/SPEC.md §3.9).
//
// C drops a GLB into the catalog, is told how big it is, names it and
// registers it. B, who has land and will build on it, finds it in the picker
// by that name.
//
// The GLB is a file on disk, which is what a player is given; everything done
// with it here is done through the page.

import { join } from 'node:path';

import { test, expect, open, panel, signIn, signUp, UI } from './players.js';
import { REPO } from './world.js';

const GLB = join(REPO, 'client/test/fixtures/assets/blender.glb');
const PRODUCT = 'Valais bench';



test('story 4 — C registers a product and B can pick it by name',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C makes an account',
            () => signUp(c, 'cara@visp.example', 'Cara'));

        await test.step('C drops a GLB in and is told what it is', async () => {
            await panel(c, 'Catalog');
            await c.page.locator('#file').setInputFiles(GLB);
            // Size in metres, triangles: what the uploader has to know before
            // they commit to it (SPEC §3.9 step 1).
            await expect(c.page.locator('#canon')).toContainText('m', { timeout: UI });
            await expect(c.page.locator('#canon')).toContainText('tris');
        });

        await test.step('C names it and registers it', async () => {
            await c.page.locator('#name').fill(PRODUCT);
            await c.page.locator('#publish').click();
            await expect(c.page.locator('#upload-status'))
                .toContainText(/registered|listed|SAN|[A-Z0-9]{4}/, { timeout: UI });
        });

        await test.step('and it is in the catalog under that name', async () => {
            await c.page.locator('#q').fill(PRODUCT);
            await c.page.getByRole('button', { name: 'Find' }).click();
            await expect(c.page.locator('#results')).toContainText(PRODUCT,
                { timeout: UI });
        });

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        await test.step('B finds it in the picker by name', async () => {
            await panel(b, 'Place');
            const search = b.page.locator('.build-search');
            await search.fill(PRODUCT);
            await search.dispatchEvent('change');
            await expect(b.page.locator('.build-assets')).toContainText(PRODUCT,
                { timeout: UI });
        });

        await c.close();
        await b.close();
    });
