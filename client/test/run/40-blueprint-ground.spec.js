// Story 40 — B sees his field as white clay (EDT.1, PLAN-editors.md D2).
//
// Shape and Lines will both open onto one ground view: the land as a matte
// white mesh of its own grid, the elevation plus his shaping, slope-tinted
// and lit from the north-west, everybody else's ground dimmed, the splats put
// away over it. The first thing that has to be true is that it is there,
// quickly, and that a stroke's worth of it is rebuilt in a few milliseconds.

import { test, expect, UI } from './players.js';
import { ben, blueprintOverHisLand, shot } from './editors.js';
import { meanColour, variety } from './pixels.js';

test.setTimeout(600_000);

const MIDDLE = { x: 440, y: 250, width: 400, height: 300 };

// A square land of 2 × 2 km around where he stands — the size PLAN-editors
// §3 rule 1 measures against — opened with the elevation already in hand.
async function fourSquareKm(b) {
    return b.page.evaluate(async () => {
        const sw = window.splatworld;
        const s = sw.sculpt.shaping();
        const lat = (s.area.bbox.south + s.area.bbox.north) / 2;
        const lon = (s.area.bbox.west + s.area.bbox.east) / 2;
        const dLon = 1000 / (111320 * Math.cos(lat * Math.PI / 180));
        const dLat = 1000 / 110540;
        const bbox = { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
        const ring = [[bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north],
            [bbox.west, bbox.north], [bbox.west, bbox.south]];
        const area = { id: 'four', bbox, rules: { name: 'four square km' },
            outline: { type: 'Polygon', coordinates: [ring] } };
        const flat = { grid: { cell: 0.3 }, at: () => 0, savedAt: () => 0, inside: () => true };
        sw.bpmode.close();
        await sw.bpmode.open(area, flat, null);
        sw.bpmode.close();
        const ms = await sw.bpmode.open(area, flat, null);
        const bp = sw.blueprint;
        const times = [];
        for (let k = 0; k < 7; k++) {
            // 64 × 64 display cells inside the first chunk.
            const [w, , , n] = bp.L.bbox;
            const rect = [w + 2 * bp.L.dLon, n - 60 * bp.L.dLat, w + 60 * bp.L.dLon,
                n - 2 * bp.L.dLat];
            times.push(bp.rebuild(rect));
        }
        times.sort((a, b) => a - b);
        const got = { ms, rebuild: times[3], cols: bp.L.cols, rows: bp.L.rows };
        sw.bpmode.close();
        return got;
    });
}

test('story 40 — B sees his field as white clay, and it is quick',
    async ({ browser, world }, testInfo) => {
        const b = await test.step('B signs back in and goes to his land',
            () => ben(browser, world, testInfo));

        const opened = await test.step('Blueprint opens over his field',
            () => blueprintOverHisLand(b));
        expect(opened.chunks, 'the land is drawn as chunks of its grid').toBeGreaterThan(0);
        expect(opened.hidden, 'the splats over it are put away').toBeGreaterThan(0);

        await test.step('it is clay: light, and not one flat colour', async () => {
            await b.page.waitForTimeout(1500);
            await shot(b, testInfo, 'story-40-blueprint');
            const middle = await b.page.screenshot({ clip: MIDDLE });
            const [r, g, bl] = meanColour(middle);
            expect((r + g + bl) / 3, 'white clay reads light').toBeGreaterThan(110);
            expect(variety(middle), 'lit and tinted, not flat').toBeGreaterThan(8);
        });

        await test.step('a 4 km² land opens in under 1.5 s; 64² cells rebuild in 8 ms',
            async () => {
                const got = await fourSquareKm(b);
                testInfo.annotations.push({ type: 'timing',
                    description: `open ${got.ms.toFixed(0)} ms at ${got.cols}×${got.rows}`
                        + `, rebuild ${got.rebuild.toFixed(2)} ms` });
                expect(got.ms).toBeLessThan(1500);
                expect(got.rebuild).toBeLessThan(8);
            });

        await test.step('closing puts the splats back', async () => {
            const hidden = await b.page.evaluate(() => window.splatworld.streamer.hidden.size);
            expect(hidden).toBe(0);
            await expect(b.page.locator('#bp-side')).toBeHidden({ timeout: UI });
        });
        await b.close();
    });
