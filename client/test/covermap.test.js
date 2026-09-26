// The map's cover pictures: a screenful is asked for once, not every frame.

import test from 'node:test';
import assert from 'node:assert/strict';

import { drawCover, forgetCover } from '../js/covermap.js';
import { SPANS } from '../js/hudmap.js';

test('every span of the map asks for a few pictures, once', () => {
    const asked = [];
    globalThis.Image = class {
        set src(url) {
            asked.push(url);
            // Nothing published: the store answers 404.
            globalThis.queueMicrotask(() => this.onerror?.());
        }
    };
    const ctx = { drawImage() {} };
    const at = { lon: 8.54, lat: 47.37 };
    const cos = Math.cos((at.lat * Math.PI) / 180);
    return (async () => {
        try {
            for (const span of SPANS) {
                forgetCover();
                asked.length = 0;
                for (let frame = 0; frame < 10; frame++) {
                    drawCover(ctx, { w: 240, h: 180, at, span, cos, filesUrl: '' });
                    await new Promise((r) => setTimeout(r, 0));
                }
                assert.ok(asked.length > 0 && asked.length <= 36,
                    `${span} m asked for ${asked.length} pictures`);
                assert.equal(new Set(asked).size, asked.length,
                    `${span} m asked for a picture twice`);
            }
        } finally {
            delete globalThis.Image;
            forgetCover();
        }
    })();
});
