// Story 35 — a wallet is a thing you hold (PLAN-money.md MN.3, M3).
//
// A hands their wallet to B, who takes it: B holds it and sees what is in it,
// and A can spend it no more. B walks off his land and drops it; it lies there,
// marked over the ground. C walks up to it and picks it up: C can spend it,
// and B cannot. Nobody took anything from anybody: every move was the
// holder's, or an offer the other one took.

import { test, expect, looking, open, panel, shows, signIn, UI } from './players.js';

// Off anybody's land, on the ground of the world (O1: anyone may pick it up).
const SPOT = { lat: 46.2900, lon: 7.8700 };

const goTo = async (p, world) => {
    await p.page.goto(`${world.pageUrl}#at=${SPOT.lat},${SPOT.lon},0,0`);
    await looking(p);
    await p.page.waitForFunction(() => Boolean(window.splatworld?.app), null,
        { timeout: 120000 });
};

async function aHandsItToB(a, b) {
    await test.step('A hands their wallet to B', async () => {
        await panel(a, 'Inventory');
        const mine = a.page.locator('.inv-held', { hasText: '92.00' });
        await mine.getByLabel('hand it to').fill('Ben');
        await mine.getByRole('button', { name: 'Hand over' }).click();
        await shows(a, 'Handing it to Ben');
        await expect(a.page.locator('.inv-held')).toContainText('handing to Ben');
    });
    await test.step('B takes it, and sees what is in it', async () => {
        await panel(b, 'Inventory');
        const offer = b.page.locator('.inv-offered', { hasText: 'Anna hands you a wallet' });
        await offer.getByRole('button', { name: 'Take it' }).click({ timeout: UI });
        await expect(b.page.locator('.inv-held')).toHaveCount(2, { timeout: UI });
        await expect(b.page.locator('.inv-held', { hasText: '92.00' })).toHaveCount(1);
    });
    await test.step('A holds no wallet, and cannot spend it', async () => {
        await panel(a, 'Wallet');
        await shows(a, 'You hold no wallet');
        await expect(a.page.locator('.wallet-pay')).toBeHidden();
    });
}

async function bDropsIt(b, world) {
    await test.step('B walks off his land and drops it', async () => {
        await goTo(b, world);
        await panel(b, 'Inventory');
        const it = b.page.locator('.inv-held', { hasText: '92.00' });
        await it.getByRole('button', { name: 'Drop here' }).click();
        await shows(b, 'It lies where you stood');
        await expect(b.page.locator('.inv-held')).toHaveCount(1, { timeout: UI });
        await expect(b.page.locator('.world-label[data-group="item"]'))
            .toHaveText('Wallet', { timeout: UI });
    });
}

async function cPicksItUp(c, world) {
    await test.step('C signs in and walks up to it', async () => {
        await signIn(c, 'cara@visp.example', 'Cara');
        await goTo(c, world);
    });
    await test.step('C picks it up, and can spend it', async () => {
        await panel(c, 'Inventory');
        const lying = c.page.locator('.inv-lying', { hasText: 'A wallet on the ground' });
        await lying.getByRole('button', { name: 'Pick up' }).click({ timeout: UI });
        await shows(c, 'You hold it now');
        await expect(c.page.locator('.inv-held', { hasText: '92.00' })).toHaveCount(1,
            { timeout: UI });
        await panel(c, 'Wallet');
        await c.page.locator('.wallet-pick').selectOption({ label: 'Wallet 1 · 92.00' });
        await expect(c.page.locator('.wallet-balance .v')).toHaveText('92.00',
            { timeout: UI });
        await expect(c.page.locator('.wallet-pay')).toBeVisible();
    });
}

test('story 35 — a wallet is handed over, dropped, and picked up',
    async ({ browser, world }, testInfo) => {
        expect(world.cash.kind, world.cash.why ?? '').toBe('taler');
        const a = await open(browser, world, 'A', testInfo);
        const b = await open(browser, world, 'B', testInfo);
        await test.step('A signs in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));
        await aHandsItToB(a, b);
        await a.close();
        await bDropsIt(b, world);
        await b.close();

        const c = await open(browser, world, 'C', testInfo);
        await cPicksItUp(c, world);
        await c.close();

        const b2 = await open(browser, world, 'B', testInfo);
        await test.step('and B holds only his own', async () => {
            await signIn(b2, 'ben@visp.example', 'Ben');
            await panel(b2, 'Inventory');
            await expect(b2.page.locator('.inv-held')).toHaveCount(1, { timeout: UI });
            await expect(b2.page.locator('.inv-held')).not.toContainText('92.00');
        });
        await b2.close();
    });
