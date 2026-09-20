// What a tab remembers of the tiles it worked on, and what it says a picture
// is. Two per tile: the frames it traced, and the splats as they are fitted.
import test from 'node:test';
import assert from 'node:assert/strict';

import { newest, Shots, shotWords } from '../js/workshots.js';

const TILE = { z: 14, x: 8551, y: 5809 };
const key = '14/8551/5809';
const framePic = { webp: new Uint8Array([1]), width: 192, height: 192 };
const splatPic = { rgba: new Uint8Array(4), width: 256, height: 256 };

test('a frame picture is kept, though a frame record names no tile', () => {
    const shots = new Shots();
    // The assemble names the tile; every frame after it is of that tile.
    shots.saw({ t: 1, event: 'assembled', tile: TILE });
    shots.saw({ t: 2, event: 'frame', done: 2, of: 3, picture: framePic });
    assert.equal(shots.size, 1);
    assert.equal(shots.get(key).frame.done, 2);
    assert.deepEqual(shots.get(key).frame.tile, TILE);
});

test('and the splats are kept beside them, not instead of them', () => {
    const shots = new Shots();
    shots.saw({ t: 1, event: 'framed', tile: TILE });
    shots.saw({ t: 2, event: 'frame', done: 3, of: 3, picture: framePic });
    shots.saw({ t: 3, event: 'train', iter: 400, of: 2400, splats: 134000,
        picture: splatPic, tile: TILE });
    const both = shots.get(key);
    assert.equal(both.frame.done, 3, 'the frame is still there');
    assert.equal(both.splat.iter, 400);
    // The card shows the newer of the two.
    assert.equal(newest(both).event, 'train');
});

test('a record with no picture and no tile changes nothing', () => {
    const shots = new Shots();
    shots.saw({ t: 1, event: 'claim' });
    assert.equal(shots.size, 0);
    assert.equal(newest(null), null);
    assert.equal(newest({}), null);
});

test('only so many tiles are kept, oldest first', () => {
    const shots = new Shots(2);
    for (const x of [1, 2, 3]) {
        shots.saw({ t: x, event: 'train', picture: splatPic, tile: { z: 14, x, y: 1 } });
    }
    assert.equal(shots.size, 2);
    assert.equal(shots.get('14/1/1'), null);
    assert.ok(shots.get('14/3/1'));
});

// The card said "256×256", which is the size of the thumbnail the tab drew.
// It reads as a claim about how big the world is being rendered, and it is not
// one: the frames are 1024 px and the thumbnail is always 256.
test('a picture says what it is of, not how big the thumbnail is', () => {
    assert.equal(shotWords({ event: 'frame', done: 2, of: 3 }), 'frame 2 of 3');
    assert.equal(shotWords({ event: 'train', iter: 400, of: 2400, splats: 134000 }),
        'step 400 of 2400 · 134,000 splats');
    assert.equal(shotWords({ event: 'seeded', splats: 60000 }),
        'the seed · 60,000 splats');
    assert.equal(shotWords({ event: 'trained' }), 'as it finished');
    assert.equal(shotWords(null), '');
    for (const words of Object.values({ f: shotWords({ event: 'frame' }) })) {
        assert.doesNotMatch(words, /256/);
    }
});
