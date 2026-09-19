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

test('a wide map is one coarse cut, not a hundred and forty fine ones', async () => {
    // What the minimap does: probe a grid twenty kilometres across in one
    // tick. heightAt asks z14 per 1.7 km and answers null until every one of
    // them lands; heightNear asks for the coarsest level first, and one cut
    // of it covers the lot (client/js/hudmap.js terrain).
    const size = 8;
    const data = new Float32Array(size * size).fill(900);
    const urls = [];
    const fetchFn = async (url) => {
        urls.push(String(url));
        return new Response(data.buffer, { status: 200 });
    };
    const floor = new DemFloor({ fetchFn });
    const probe = (fn) => {
        for (let i = -6; i <= 6; i++) {
            for (let j = -6; j <= 6; j++) fn.call(floor, 7.85 + i * 0.022, 46.29 + j * 0.015);
        }
    };
    probe(floor.heightNear);
    assert.equal(urls.length, 1, `asked for ${urls.length} cuts, not one`);
    assert.match(urls[0], /\/geo\/dem\/6\//, 'and the one it asked for is the coarsest');

    await tick(); await tick();
    let answered = 0;
    probe(function counted(lon, lat) {
        if (this.heightNear(lon, lat) !== null) answered++;
    });
    assert.equal(answered, 169, 'and then the whole map has ground');
});

test('fill is not ground: a coarse cut does not pave what the survey missed', async () => {
    // loadRaster refuses a cut only when the whole window is fill, and
    // heightNear asks for a coarse tile as itself — so a z6 cut with one
    // surveyed corner arrives whole. The fill in it is written as an
    // elevation of zero (server/splatworld/dem.py), which is not sea level
    // and is not somewhere a player stands.
    const size = 8;
    const data = new Float32Array(size * size);        // all fill …
    data[0] = 1800;                                    // … but one surveyed pixel
    const floor = new DemFloor({
        fetchFn: async () => new Response(data.buffer, { status: 200 }),
    });
    floor.heightNear(7.85, 46.29);
    await tick(); await tick();
    assert.equal(floor.heightNear(7.85, 46.29), null,
        'the middle of the cut is fill, so there is no ground there');
    assert.equal(floor.heightAt(7.85, 46.29), null, 'and none under the player either');
});

test('a tile is asked for by the level and tile it is, whoever asks', async () => {
    // Everything that wants a raster goes through raster(): the ground mesh
    // kept its own spelling of the cache key and got undefined for every tile
    // there is, so a world with an elevation had no ground mesh in it.
    const size = 8;
    const data = new Float32Array(size * size).fill(1500);
    const urls = [];
    const fetchFn = async (url) => {
        urls.push(String(url));
        return new Response(data.buffer, { status: 200 });
    };
    const floor = new DemFloor({ filesUrl: 'http://files', fetchFn });
    assert.equal(floor.raster(14, 8557, 5736), undefined, 'on its way');
    await tick(); await tick();
    assert.ok(floor.raster(14, 8557, 5736), 'and in hand afterwards');
    assert.equal(urls.length, 1, 'asked once');
    assert.ok(urls[0].endsWith('/geo/dem/14/8557/5736.r16'), urls[0]);
});
