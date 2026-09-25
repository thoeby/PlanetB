// Story 47 — every tab is a peer (TASKS-live.md LV.12).
//
// B stands by the gate (story 41): his tab fetched its model, keeps it, and
// tells the world it holds it. C comes by with the world's store out of her
// reach — /assets and /ipfs refuse her — and sees the gate anyway: it came from
// Ben's tab, by its CID, and her tab hashed it on arrival. Then B has gone and
// A's tab claims to hold the gate but sends other bytes. C, back for another
// visit, is sent them: her page drops A's tab for the visit and says so, and
// the gate comes from the world's own node instead.

import { test, expect, looking, open, signIn, UI } from './players.js';
import { GATE_AT, goesToTheLand, sees, stands } from './things.js';

const START = { north: GATE_AT.north - 0.00018, east: GATE_AT.east };

// The gate on this page, and the file it was drawn from.
const theGate = (p) => p.page.evaluate(() => {
    const row = [...window.splatworld.preview.rows.values()]
        .find((r) => r.name === 'Schranke');
    return row ? { id: row.id, sha: row.sha256 } : null;
});

const cidOf = async (world, sha) => (await fetch(`${world.apiUrl}/rpc/cid_of`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256: sha }) })).json();

const holders = async (world, cid) => (await fetch(`${world.apiUrl}/rpc/peers_for`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cid }) })).json();

const cameFrom = (p, cid) => p.page.evaluate((want) =>
    window.splatworld.peers.from.get(want) ?? null, cid);

// The store is not there for this tab: every file has to come from a peer.
async function withoutTheStore(p) {
    const refused = [];
    await p.context.route(/\/(assets|ipfs)\//, (route) => {
        refused.push(route.request().url());
        return route.abort('connectionrefused');
    });
    return refused;
}

// Ben's field is found from Ben's own "Go there"; everybody else is given
// the place (SPEC §3.8), here as where it is.
async function comesBy(p, world, email, name, field = null) {
    await signIn(p, email, name);
    const here = field ?? await goesToTheLand(p);
    await stands(p, world, here, START.north, START.east);
    await looking(p);
    await expect.poll(() => theGate(p), { timeout: UI }).not.toBeNull();
    return { ...(await theGate(p)), here };
}

// A's tab, made to answer for the gate with bytes that are not it — and to
// say it holds it.
async function lies(a, world, cid) {
    await signIn(a, 'anna@visp.example', 'Anna');
    await expect.poll(() => a.page.evaluate(() => Boolean(window.splatworld.peers.id)),
        { timeout: UI }).toBe(true);
    await a.page.evaluate(async (want) => {
        const { peers } = window.splatworld;
        const honest = peers.local.bind(peers);
        peers.local = async (asked) => (asked === want
            ? new TextEncoder().encode('not a gate at all') : honest(asked));
        peers.held.add(want);
        await peers.tell();
    }, cid);
    await expect.poll(async () => (await holders(world, cid)).map((h) => h.player),
        { timeout: UI }).toEqual(['Anna']);
}

test('story 47 — a tab gets the gate from another tab, and a liar is dropped',
    async ({ browser, world }, testInfo) => {
        const b = await open(browser, world, 'B', testInfo);
        const gate = await test.step('B stands by the gate, and his tab has its model',
            () => comesBy(b, world, 'ben@visp.example', 'Ben'));
        await sees(b, gate.id).toBe(true);
        const cid = await cidOf(world, gate.sha);
        expect(cid, 'the model has a CID beside its sha256').toMatch(/^bafk/);
        await test.step('and tells the world he holds it', async () => {
            await expect.poll(async () => (await holders(world, cid)).map((h) => h.player),
                { timeout: UI }).toContain('Ben');
        });

        const c = await open(browser, world, 'C', testInfo);
        const refused = await withoutTheStore(c);
        await test.step('1 — C comes by with the store out of reach, and sees the gate',
            async () => {
                await comesBy(c, world, 'cara@visp.example', 'Cara', gate.here);
                await sees(c, gate.id).toBe(true);
                expect(await cameFrom(c, cid), 'the gate came from Ben\'s tab').toBe('Ben');
                expect(refused.filter((u) => u.includes(gate.sha) || u.includes(cid)),
                    'and not from the store').toEqual([]);
            });
        await test.step('B and C close their tabs, and the world no longer lists them',
            async () => {
                // Closing, as a person does: the page is told it is going.
                await c.page.close({ runBeforeUnload: true });
                await b.page.close({ runBeforeUnload: true });
                await expect.poll(() => holders(world, cid), { timeout: UI }).toEqual([]);
            });
        await c.close();
        await b.close();

        const a = await open(browser, world, 'A', testInfo);
        await test.step('2 — A\'s tab says it holds the gate, and sends other bytes',
            () => lies(a, world, cid));

        const c2 = await open(browser, world, 'C', testInfo);
        await test.step('3 — C, on another visit, drops A\'s tab and says so', async () => {
            await comesBy(c2, world, 'cara@visp.example', 'Cara', gate.here);
            await expect(c2.page.locator('#trigger-said')).toContainText(
                `Anna’s tab sent bytes that are not glb ${gate.sha.slice(0, 8)}; it is skipped`
                + ' for the rest of this visit.', { timeout: UI });
            await sees(c2, gate.id).toBe(true);
            expect(await cameFrom(c2, cid), 'the gate came from the world\'s node')
                .toMatch(/^(node|http)$/);
        });
        await c2.close();
        await a.close();
    });
