// Story 7 — approving (docs/SPEC.md §3.6).
//
// B owns the land they built on, so the submission is waiting for B. They see
// it, review it in place with Before / After, and approve: the tiles are
// queued and the render jobs are in the pool. Then the refuse branch — a
// second submission, refused with a note, and the note is what B reads
// afterwards.

import { test, expect, open, panel, signIn, UI } from './players.js';
import { drawInQgis, qgisPython } from './qgis.js';

const readCoords = (text) => {
    const m = /([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/.exec(text ?? '');
    return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
};

const squareAt = ({ lon, lat }, size = 0.0004) =>
    `POLYGON((${lon - size} ${lat - size}, ${lon + size} ${lat - size},`
    + ` ${lon + size} ${lat + size}, ${lon - size} ${lat + size},`
    + ` ${lon - size} ${lat - size}))`;

test('story 7 — B reviews what is waiting and decides',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs in', () => signIn(b, 'ben@visp.example', 'Ben'));

        await test.step('B is told something is waiting', async () => {
            await expect(b.page.locator('#attention')).toHaveText(/[1-9]/,
                { timeout: UI });
        });

        await test.step('and it is there, with who sent it and what it is',
            async () => {
                await panel(b, 'Permission');
                await expect(b.page.locator('.pm-card'))
                    .toContainText('Ben’s field', { timeout: UI });
                await expect(b.page.locator('.pm-card')).toContainText('by Ben');
                await expect(b.page.locator('.pm-said'))
                    .toHaveText('the benches by the path');
            });

        await test.step('B reviews it in place, and Before hides what was built',
            async () => {
                await b.page.getByRole('button', { name: 'Review' }).click();
                await expect(b.page.locator('.pm-status'))
                    .toContainText('Reviewing in place', { timeout: UI });
                await expect(b.page.locator('.world-label[data-tone="warn"]').first())
                    .toBeVisible({ timeout: UI });
                await b.page.locator('.pm-after').uncheck();
                await expect(b.page.locator('.pm-status'))
                    .toContainText('without it', { timeout: UI });
                await b.page.locator('.pm-after').check();
            });

        await test.step('B approves, and the tiles are queued', async () => {
            await b.page.getByRole('button', { name: 'Approve' }).click();
            await expect(b.page.locator('.pm-status'))
                .toContainText('queued', { timeout: UI });
        });

        await test.step('the land says so too', async () => {
            await panel(b, 'Your land');
            await expect(b.page.locator('.land-detail .tile')
                .filter({ hasText: 'In the pool' }))
                .not.toHaveText(/^0/, { timeout: UI });
        });

        await refuseBranch(b, world);
        await b.close();
    });

// The other half of §3.6: a refusal carries a reason, and the reason is what
// the person who built it reads afterwards.
async function refuseBranch(b, world) {
    test.skip(!qgisPython(), 'no PyQGIS here — install qgis and python3-qgis');

    const here = await test.step('B draws something else on their land', async () => {
        await panel(b, 'Your land');
        await b.page.getByRole('button', { name: 'Go there' }).first().click();
        await expect(b.page.locator('#land')).toHaveText('Ben’s field',
            { timeout: UI });
        const at = readCoords(await b.page.locator('#standing .coords').textContent());
        const waiting = b.page.waitForEvent('download', { timeout: UI });
        await b.page.getByRole('button', { name: 'Shape this land in QGIS' }).click();
        const file = await waiting;
        const path = `${world.filesUrl.replace(/[^a-z]/g, '')}-project.qgs`;
        await file.saveAs(`/tmp/${path}`);
        const [out] = drawInQgis(`/tmp/${path}`, [{
            layer: 'Water', geometry: squareAt({ lon: at.lon + 0.001, lat: at.lat }),
        }]);
        expect(out.error ?? '', 'the pond saved').toBe('');
        return at;
    });
    expect(here).not.toBeNull();

    await test.step('B submits it', async () => {
        await panel(b, 'Submit');
        await expect(b.page.locator('.su-send')).toBeEnabled({ timeout: UI });
        await b.page.locator('.su-note').fill('a pond');
        await b.page.locator('.su-send').click();
        await expect(b.page.locator('.su-status'))
            .toContainText('awaiting approval', { timeout: UI });
    });

    await test.step('and refuses it, with a reason', async () => {
        await panel(b, 'Permission');
        await expect(b.page.locator('.pm-said')).toHaveText('a pond',
            { timeout: UI });
        await b.page.locator('.pm-note').fill('the pond is inside the road');
        await b.page.getByRole('button', { name: 'Refuse' }).click();
        await expect(b.page.locator('.pm-status'))
            .toContainText('refused', { timeout: UI });
    });

    await test.step('the reason is on the land afterwards', async () => {
        await panel(b, 'Your land');
        await expect(b.page.locator('.land-refused'))
            .toContainText('the pond is inside the road', { timeout: UI });
    });
}
