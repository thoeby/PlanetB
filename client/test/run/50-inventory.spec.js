// Story 50 — the Inventory, and placing from it (TASKS-ui.md UI.3).
//
// B takes the crate in the Shop; it is in his Inventory beside what he already
// holds. Place on its card walks into build mode with the crate in hand and
// the camera stepped close enough that a crate is something to look at, not a
// speck — and one click on the ground puts it down.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { goesToTheLand, stands, thingsOn } from './things.js';
import { inTheShop } from './selling.js';

async function takesTheCrate(b) {
    const card = await inTheShop(b, 'Kiste');
    await card.locator('.mk-name').click();
    const detail = b.page.locator('#detail');
    await expect(detail.locator('h2')).toHaveText('Kiste', { timeout: UI });
    await detail.locator('button.buy').click();
    await expect(b.page.locator('#status')).toContainText('licensed S', { timeout: UI });
}

// How high the camera is over the ground under it, and whether it flies.
const camera = (b) => b.page.evaluate(() => {
    const { player, terrain } = window.splatworld;
    const p = player.position;
    const ground = terrain.heightAt({ x: p.x, y: p.y, z: p.z }) ?? 0;
    return { over: p.y - ground, mode: document.getElementById('hints').dataset.mode };
});

test('story 50 — B places a crate from his Inventory', async ({ browser, world }, testInfo) => {
    const b = await open(browser, world, 'B', testInfo);
    await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
    const here = await goesToTheLand(b);
    // A clear stretch of his field, south of where everything else stands.
    await stands(b, world, here, -0.001);

    await test.step('1 — B takes the crate in the Shop, and it is in his Inventory',
        async () => {
            await takesTheCrate(b);
            await panel(b, 'Inventory');
            const shelf = b.page.locator('.inv-cards');
            await expect(shelf.locator('.inv-card', { hasText: 'Kiste' }))
                .toContainText('licence since', { timeout: UI });
            await expect(shelf.locator('.inv-card', { hasText: 'Barrier' })).toBeVisible();
        });

    const before = new Set(await thingsOn(b));
    await test.step('2 — Place: build mode, the crate in hand, the camera close', async () => {
        await b.page.locator('.inv-card', { hasText: 'Kiste' })
            .getByRole('button', { name: 'Place' }).click();
        await expect(b.page.locator('.build-toggle')).toBeChecked({ timeout: UI });
        await expect(b.page.locator('.build-hint'))
            .toHaveText('Click the ground to put Kiste down · Esc leaves build mode');
        const cam = await camera(b);
        expect(cam.mode, 'it flies, so the height stays').toBe('fly');
        // framing(): a crate is looked at from four metres, at 35° down.
        expect(cam.over).toBeGreaterThan(1.5);
        expect(cam.over).toBeLessThan(4);
    });

    await test.step('3 — one click on the ground puts it down', async () => {
        const box = await b.page.locator('#view').boundingBox();
        await b.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(b.page.locator('.build-sel')).not.toContainText('brush', { timeout: UI });
        await b.page.locator('.build-save').click();
        await expect(b.page.locator('.build-saved')).toContainText('object', { timeout: UI });
        await expect.poll(async () =>
            (await thingsOn(b)).filter((id) => !before.has(id)).length,
        { timeout: UI }).toBe(1);
    });
    await b.close();
});
