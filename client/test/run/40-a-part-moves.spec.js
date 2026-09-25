// Story 40 — a part may move (TASKS-live.md LV.1).
//
// C registers a crane whose arm is a joint that can be told a pose. B puts one
// on his field; A stands by it. B swings the arm a quarter turn over four
// seconds, and both tabs put it at the same place at the same world second —
// neither was sent a frame, both evaluated the one row the world recorded
// against the one clock (client/lib/joint.js). And nothing was compiled: the
// tiles under the crane are exactly the versions they were.

import { test, expect, looking, open, signIn, UI } from './players.js';
import { goesToTheLand, plants, registers, sees, stands, tilesUnder, whereIs }
    from './things.js';

// What one tab has the arm at: the pose livedraw last put it in.
const armAt = (player, id) => player.page.evaluate((want) =>
    window.splatworld.liveDraw.extra.get(want)?.get('arm')?.at ?? null, id);

// Where one tab would put the arm at a given world second — the same question
// asked of both tabs, so the answers can be compared number for number.
const armWhen = (player, id, t) => player.page.evaluate(([want, at]) => {
    const { liveDraw, live } = window.splatworld;
    const mark = liveDraw.extra.get(want)?.get('arm')?.joint;
    return mark ? liveDraw.jointPose(live, want, mark, at) : null;
}, [id, t]);

const told = (player, id) => player.page.evaluate((want) =>
    window.splatworld.live.rowsOf(want).find((r) => r.port === 'pose') ?? null, id);

async function registersTheCrane(c) {
    await registers(c, 'crane.glb', 'Kran', [{ node: 'arm', role: 'joint', ports: ['pose'] }]);
    await expect(c.page.locator('#upload-status')).toContainText('published S');
}

async function swings(b) {
    const pose = b.page.locator('.build-ports li[data-port="pose"]');
    await expect(pose).toBeVisible({ timeout: UI });
    await pose.locator('.pm-yaw').fill('90');
    await pose.locator('.pm-over').fill('4');
    await pose.locator('.pm-go').click();
    await expect(b.page.locator('.build-ports-said')).toContainText('pose set',
        { timeout: UI });
}

test('story 40 — a crane swings its arm, and both tabs see it arrive together',
    async ({ browser, world }, testInfo) => {
        const c = await open(browser, world, 'C', testInfo);
        await test.step('C signs back in', () => signIn(c, 'cara@visp.example', 'Cara'));
        await test.step('C registers a crane whose arm moves', () => registersTheCrane(c));
        await c.close();

        const b = await open(browser, world, 'B', testInfo);
        await test.step('B signs back in', () => signIn(b, 'ben@visp.example', 'Ben'));
        const here = await test.step('and goes to their land', () => goesToTheLand(b));
        const byTheCrane = await stands(b, world, here, 0.00072);
        const crane = await test.step('B puts the crane down', () => plants(b, 'Kran'));

        const a = await open(browser, world, 'A', testInfo);
        await test.step('A signs back in', () => signIn(a, 'anna@visp.example', 'Anna'));
        await test.step('and stands by the crane', async () => {
            await a.page.goto(byTheCrane);
            await looking(a);
            await sees(a, crane).toBe(true);
        });

        const spot = await whereIs(b, crane);
        const before = await tilesUnder(world, spot.lon, spot.lat);

        await test.step('1 — B swings the arm a quarter turn over four seconds',
            async () => {
                await b.page.bringToFront();
                await swings(b);
            });

        await test.step('2 — both tabs have the arm arrive at the same world second',
            async () => {
                await expect.poll(() => told(a, crane), { timeout: 10_000,
                    message: 'A is told the arm was moved' }).not.toBeNull();
                const [inA, inB] = [await told(a, crane), await told(b, crane)];
                expect(inA.clock, 'one write, one clock').toBe(inB.clock);
                const arrives = Number(inA.clock) + 4;
                // Half way, and after: the same answer from both tabs.
                for (const t of [arrives - 2, arrives + 1]) {
                    const [pa, pb] = [await armWhen(a, crane, t), await armWhen(b, crane, t)];
                    expect(pa.yaw).toBeCloseTo(pb.yaw, 6);
                }
                expect((await armWhen(a, crane, arrives - 2)).yaw).toBeCloseTo(45, 3);
                // And what each has actually drawn, once it has arrived.
                for (const p of [a, b]) {
                    await expect.poll(async () => (await armAt(p, crane))?.yaw ?? null,
                        { timeout: UI, message: `${p.name} sees the arm round` })
                        .toBeCloseTo(90, 3);
                }
            });

        await test.step('3 — and nothing was compiled for it', async () => {
            const after = await tilesUnder(world, spot.lon, spot.lat);
            expect(after.map((t) => [t.z, t.expected_version]),
                'every tile over the crane is the version it was')
                .toEqual(before.map((t) => [t.z, t.expected_version]));
        });

        await a.close();
        await b.close();
    });
