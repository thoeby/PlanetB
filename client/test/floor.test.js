// The floor under a player where nothing is published (client/js/floor.js).
import assert from 'node:assert/strict';
import test from 'node:test';

import { DemFloor } from '../js/floor.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a height arrives after the tile does, and is the elevation there', async () => {
    const size = 8;
    const data = new Float32Array(size * size).fill(1234);
    const fetchFn = async () => new Response(data.buffer, { status: 200 });
    const floor = new DemFloor({ filesUrl: 'http://files', fetchFn });
    assert.equal(floor.heightAt(7.85, 46.29), null, 'nothing yet: the tile is on its way');
    await tick(); await tick();
    assert.equal(floor.heightAt(7.85, 46.29), 1234);
});

test('outside the coverage there is no floor, and it is not asked for again', async () => {
    let asked = 0;
    const fetchFn = async () => { asked++; return new Response('', { status: 404 }); };
    const floor = new DemFloor({ fetchFn });
    floor.heightAt(7.85, 46.29);
    await tick(); await tick();
    assert.equal(floor.heightAt(7.85, 46.29), null);
    assert.equal(asked, 5, 'each zoom up to z6 asked once, then remembered');
});
