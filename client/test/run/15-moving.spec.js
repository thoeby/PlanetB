// Walking and flying, and the corner that says which one you are in.
//
// Not one of SPEC §3's stories: these are the controls the operator could not
// tell apart. Shift runs on the ground and goes down in the air; forward
// follows where you are looking only in the air; and until now nothing on
// screen said which of the two you were in.

import { test, expect, open, signIn, UI } from './players.js';

const height = async (page) => {
    const said = await page.locator('#standing .coords').textContent();
    const m = /·\s*(-?\d+)\s*m/.exec(said ?? '');
    return m ? Number(m[1]) : null;
};

const hold = async (page, key, ms) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
};

test('the page says whether you are walking or flying, and flying goes where you look',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs in', () => signIn(a, 'anna@visp.example', 'Anna'));

        // Into the world, out of the panel the page opened on: a player
        // presses Escape and clicks the window before they walk anywhere.
        const intoTheWorld = async () => {
            await a.page.keyboard.press('Escape');
            await a.page.locator('#view').click({ position: { x: 640, y: 300 } });
        };

        const hints = a.page.locator('#hints');
        await test.step('the corner says A is walking, and how to fly', async () => {
            await expect(hints).toContainText('Walking', { timeout: UI });
            await expect(hints).toContainText('Run');
            await expect(hints).toContainText('Fly');
        });

        await test.step('A presses the key the corner named', async () => {
            await intoTheWorld();
            await a.page.keyboard.press('KeyF');
            await expect(hints).toContainText('Flying', { timeout: UI });
            // The controls are different ones, and the corner says so.
            await expect(hints).toContainText('Up');
            await expect(hints).toContainText('Down');
            await expect(hints).toContainText('where you look');
        });

        await test.step('A climbs', async () => {
            const before = await height(a.page);
            await hold(a.page, 'Space', 3000);
            await expect.poll(() => height(a.page), { timeout: UI })
                .toBeGreaterThan(before + 50);
        });

        // Where forward goes when you are looking somewhere is exact, and is
        // checked exactly in client/test/player.test.js: pointing the camera
        // needs the mouse, and the mouse needs a pointer lock this browser
        // does not always give a headless page.
        await test.step('and Shift is down rather than run', async () => {
            const before = await height(a.page);
            await hold(a.page, 'Shift', 2000);
            await expect.poll(() => height(a.page), { timeout: UI })
                .toBeLessThan(before - 50);
        });

        await test.step('A walks again, and the corner says so', async () => {
            await a.page.keyboard.press('KeyF');
            await expect(hints).toContainText('Walking', { timeout: UI });
        });

        await a.close();
    });
