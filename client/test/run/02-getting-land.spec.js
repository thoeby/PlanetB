// Story 2 — getting land (docs/SPEC.md §3.2).
//
// B has an account and no ground of their own. They ask for some; A, who is
// the admin because they were first, draws it on the map in the page and hands
// it over; B is told, goes there, and stands on land with their name on it.
//
// And land in the wrong place cannot be made: A turns the boundary's
// coordinates the wrong way round and reads what the world says about it.

import { test, expect, open, shows, panel, UI } from './players.js';

const swap = (text) => text.trim().split('\n')
    .map((line) => line.split(',').map((n) => n.trim()).reverse().join(', '))
    .join('\n');

const pairs = (text) => text.trim().split('\n')
    .map((line) => line.split(',').map(Number));

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

async function signUp(player, email, name) {
    const { page } = player;
    await panel(player, 'Setup');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'create account' }).click();
    await expect(page.getByText(email).first()).toBeVisible({ timeout: UI });
    await page.getByLabel('your name').fill(name);
    await page.getByRole('button', { name: 'save name' }).click();
    await shows(player, name);
    await panel(player, 'World');
}

async function signIn(player, email, name) {
    await panel(player, 'Setup');
    await player.page.getByLabel('email').fill(email);
    await player.page.getByLabel('password').fill('a-long-enough-password');
    await player.page.getByRole('button', { name: 'sign in' }).click();
    await shows(player, name);
    await panel(player, 'World');
}

async function asksForLand(b) {
    await test.step('B has no land, and is told who hands it out', async () => {
        await panel(b, 'Your land');
        await shows(b, 'Land is assigned by an admin');
        await shows(b, 'Anna');
    });
    await test.step('B asks for some, and says what for', async () => {
        await b.page.getByLabel('what land do you want').fill('near Visp, ~2 ha');
        await b.page.getByRole('button', { name: 'Request land' }).click();
        await shows(b, 'with the admin');
    });
}

// A draws four corners on the map, which is where the boundary comes from:
// the script never types the land's position, it reads it back off the page.
async function drawsTheBoundary(a) {
    const map = a.page.locator('#assign-map');
    await expect(map).toBeVisible({ timeout: UI });
    // A player scrolls the panel until they can see the map; so does this,
    // before it works out where the corners go.
    await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    for (const [fx, fy] of [[0.42, 0.42], [0.58, 0.42], [0.58, 0.58], [0.42, 0.58]]) {
        const p = at(fx, fy);
        await a.page.mouse.click(p.x, p.y);
    }
    await a.page.getByRole('button', { name: 'Finish the boundary' }).click();
    const drawn = await a.page.getByLabel('boundary').inputValue();
    expect(pairs(drawn).length, 'four corners came off the map')
        .toBeGreaterThanOrEqual(4);
    return drawn;
}

async function goesThere(b, drawn) {
    await test.step('B goes there and stands on their own land', async () => {
        await panel(b, 'Your land');
        await shows(b, 'Ben\u2019s field');
        await b.page.getByRole('button', { name: 'Go there' }).first().click();
        await expect(b.page.locator('#land')).toHaveText('Ben\u2019s field',
            { timeout: UI });
        await shows(b, 'you may build here');
        // SPEC §3.2, post: claiming land renders nothing, so there is nothing
        // waiting to be submitted on it yet.
        await expect(b.page.locator('.tile', { hasText: 'Unsubmitted' }))
            .toContainText('0', { timeout: UI });
        const at = readCoords(await b.page.locator('#standing .coords').textContent());
        const lons = pairs(drawn).map((p) => p[0]);
        const lats = pairs(drawn).map((p) => p[1]);
        expect(at.lon, 'B is inside the boundary A drew')
            .toBeGreaterThan(Math.min(...lons) - 0.001);
        expect(at.lon).toBeLessThan(Math.max(...lons) + 0.001);
        expect(at.lat).toBeGreaterThan(Math.min(...lats) - 0.001);
        expect(at.lat).toBeLessThan(Math.max(...lats) + 0.001);
    });
}

test('story 2 — land is asked for, drawn, and handed over', async ({ browser, world },
    testInfo) => {
    const a = await open(browser, world, 'A', testInfo);
    const b = await open(browser, world, 'B', testInfo);
    await test.step('A signs back in as the admin of this world',
        () => signIn(a, 'anna@visp.example', 'Anna'));
    await test.step('B makes an account',
        () => signUp(b, 'ben@visp.example', 'Ben'));
    await asksForLand(b);

    await test.step('A sees the request, with what B wrote', async () => {
        await panel(a, 'Admin');
        await shows(a, 'Ben');
        await shows(a, 'near Visp, ~2 ha');
    });

    const drawn = await test.step('A draws it on the map', () => drawsTheBoundary(a));

    await test.step('land whose coordinates are the wrong way round is refused',
        async () => {
            await a.page.getByLabel('boundary').fill(swap(drawn));
            await a.page.getByLabel('name this land').fill('Ben’s field');
            await a.page.getByRole('button', { name: 'Assign this land' }).click();
            await shows(a, 'longitude and latitude swapped');
        });

    await test.step('A puts the boundary back and hands the land over', async () => {
        await a.page.getByLabel('boundary').fill(drawn);
        await a.page.getByRole('button', { name: 'Assign this land' }).click();
        await shows(a, 'assigned to Ben');
    });

    await test.step('B is told, without being asked to look', async () => {
        await expect(b.page.locator('#attention')).toHaveText(/[1-9]/, { timeout: UI });
        await b.page.locator('#attention').click();
        await shows(b, 'Ben’s field');
    });

    await goesThere(b, drawn);

    await test.step('and the land says whose it is, on the ground', async () => {
        await expect(b.page.locator('.world-label', { hasText: 'Ben’s field' }))
            .toBeVisible({ timeout: UI });
    });

    await a.close();
    await b.close();
});
