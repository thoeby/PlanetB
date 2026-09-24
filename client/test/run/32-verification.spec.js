// Story 32 — a player is a verified person (PLAN-identity.md ID.1, ID.4).
//
// E signs up and is not verified: Profile → Verify says so and what verifying
// unlocks, and Your land says to verify first before E has asked for anything.
// The e-ID path is offered, and this world has no swiyu verifier, so it says
// that in place and points at the other one (§3, "swiyu not reachable").
//
// Without e-ID: E's first request is refused by A with a note, which E reads.
// E then types somebody else's name and birth date — Ben's, who was verified
// in story 2 — and the world refuses it itself: one person, one account (V3).
// E's own details, checked on a call, make E verified, and E's wallet with the
// starting amount is in the inventory (PLAN-identity.md, "Goes with
// PLAN-money.md").
//
// ID.0, ID.2, ID.3 and ID.6 need the swiyu public beta and are not run here
// (PLAN-identity.md, Blocked).

import { test, expect, open, panel, shows, signIn, signUp, UI } from './players.js';

async function asks(e, { given, family, born, how }) {
    await panel(e, 'Verify');
    await e.page.getByLabel('given names').fill(given);
    await e.page.getByLabel('family name').fill(family);
    await e.page.getByLabel('birth date').fill(born);
    await e.page.getByLabel('how the admin can check it').fill(how);
    await e.page.getByRole('button', { name: 'Ask an admin' }).click();
}

async function decides(a, family, words, verb) {
    await panel(a, 'Players');
    const card = a.page.locator('.players-request', { hasText: family });
    await expect(card).toBeVisible({ timeout: UI });
    await card.getByLabel('note').fill(words);
    await card.getByRole('button', { name: verb }).click();
}

test('story 32 — E is verified by an admin, and one person has one account',
    async ({ browser, world }, testInfo) => {
        const a = await open(browser, world, 'A', testInfo);
        const e = await open(browser, world, 'E', testInfo);
        await test.step('A signs in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('E makes an account', () => signUp(e, 'emil@visp.example', 'Emil'));

        await test.step('E is not verified, and is told what verifying unlocks', async () => {
            await panel(e, 'Verify');
            await shows(e, 'Not verified');
            await shows(e, 'Verifying unlocks getting land, holding a wallet');
            await panel(e, 'Your land');
            await shows(e, 'Verify first');
        });

        await test.step('the e-ID path says where it stands, in place', async () => {
            await panel(e, 'Verify');
            await e.page.getByRole('button', { name: 'With e-ID' }).click();
            await shows(e, 'swiyu is not reachable from this world');
            await shows(e, 'verify without e-ID');
        });

        await test.step('E asks an admin; A refuses, and says why', async () => {
            await asks(e, { given: 'Emil', family: 'Kalbermatten', born: '1979-06-30',
                how: 'a video call' });
            await shows(e, 'Waiting for an admin');
            await decides(a, 'Kalbermatten', 'the call never happened — ask again', 'Refuse');
            await shows(a, 'was refused');
            await panel(e, 'Verify');
            await expect(e.page.locator('.verify-state'))
                .toContainText('the call never happened', { timeout: UI });
        });

        await test.step('somebody already verified cannot be verified twice', async () => {
            await asks(e, { given: 'Ben', family: 'Imboden', born: '1991-03-14',
                how: 'in person' });
            await shows(e, 'an account for this person already exists');
        });

        await test.step('E asks again as E; A checks it on a call and confirms', async () => {
            await asks(e, { given: 'Emil', family: 'Kalbermatten', born: '1979-06-30',
                how: 'a video call, Tuesday' });
            await shows(e, 'Waiting for an admin');
            await decides(a, 'Kalbermatten', 'checked on a video call', 'Confirm');
            await shows(a, 'Emil is verified');
            await panel(e, 'Verify');
            await expect(e.page.locator('.verify-state'))
                .toHaveText('Verified by Anna — checked on a video call', { timeout: UI });
        });

        await test.step('and the name E typed is not kept', async () => {
            await panel(a, 'Players');
            await expect(a.page.locator('.players-player', { hasText: 'Emil' }))
                .toContainText('verified · by an admin · Anna', { timeout: UI });
            await expect(a.page.getByText('Kalbermatten')).toHaveCount(0);
        });

        await a.close();
        await e.close();
    });
