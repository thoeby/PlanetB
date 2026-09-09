// WP4.1 — canon-v1's acceptance: five GLBs written the way three different
// tools write them all reduce to one SAN.
//
// The fixtures are committed; `node tools/make-asset-fixtures.mjs` rebuilds
// them. What each one does differently is documented in that file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalise, sanOf } from '../lib/canon.js';
import { parseGlb, readAccessor, resolveBuffers } from '../lib/glb.js';
import { boxResize, decodePng, encodePng, imageInfo } from '../lib/png.js';
import { checker, FIXTURES } from '../../tools/make-asset-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAMES = ['blender', 'blender-interleaved', 'cad', 'cad-split', 'sketchfab'];

const fixture = (name) =>
    new Uint8Array(readFileSync(join(HERE, 'fixtures/assets', `${name}.glb`)));

test('five fixtures from three exporters canonicalise to one SAN', async () => {
    const results = [];
    for (const name of NAMES) results.push([name, await canonicalise(fixture(name))]);
    const [, first] = results[0];
    assert.match(first.san, /^S[A-Z2-7]{12}$/);
    for (const [name, r] of results) {
        assert.equal(r.san, first.san, `${name} has a different SAN`);
        assert.equal(r.sha256, first.sha256, `${name} has different canonical bytes`);
        assert.deepEqual(Array.from(r.glb), Array.from(first.glb), `${name} differs byte for byte`);
    }
});

test('the canonical form is the model, measured', async () => {
    const r = await canonicalise(fixture('blender'));
    assert.equal(r.canon_version, 1);
    assert.equal(r.meta.tris, 36);                        // two boxes: 12 + 24
    assert.equal(r.meta.materials, 2);
    assert.deepEqual(r.meta.bbox, { min: [-0.9, 0, -0.25], max: [0.9, 0.5, 0.25] });
});

test('the origin is the bottom centre of the bounding box', async () => {
    const { glb } = await canonicalise(fixture('cad'));
    const { json, bin } = parseGlb(glb);
    const buffers = resolveBuffers(json, bin);
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const prim of json.meshes[0].primitives) {
        const pos = readAccessor(json, buffers, prim.attributes.POSITION);
        for (let i = 0; i < pos.length; i += 3) {
            min = min.map((v, c) => Math.min(v, pos[i + c]));
            max = max.map((v, c) => Math.max(v, pos[i + c]));
        }
    }
    assert.equal(min[1], 0, 'the model stands on y = 0');
    assert.ok(Math.abs(min[0] + max[0]) < 1e-6, 'centred in x');
    assert.ok(Math.abs(min[2] + max[2]) < 1e-6, 'centred in z');
});

test('the canonical GLB keeps nothing an exporter added for a human', async () => {
    const { json } = parseGlb((await canonicalise(fixture('blender'))).glb);
    assert.equal(json.asset.generator, 'canon-v1');
    assert.equal(json.nodes.length, 1);
    assert.equal(json.meshes.length, 1);
    assert.equal(json.extensionsUsed, undefined, 'KHR_texture_transform and EXT_ are dropped');
    assert.equal(JSON.stringify(json).includes('"name"'), false);
    assert.equal(JSON.stringify(json).includes('extras'), false);
    assert.deepEqual(Object.keys(json.accessors[0]).sort(),
        ['bufferView', 'componentType', 'count', 'max', 'min', 'type'],
        'every object has its keys in sorted order');
});

test('a SAN is 60 bits of the digest in base32', () => {
    assert.equal(sanOf('0'.repeat(64)), `S${'A'.repeat(12)}`);
    assert.equal(sanOf('f'.repeat(64)), `S${'7'.repeat(12)}`);
    assert.equal(sanOf('00'.repeat(7) + 'ff' + '00'.repeat(24)), 'SAAAAAAAAAAAP');
});

// ---------------------------------------------------------------- the codec

test('an oversized texture is shrunk to 2048 and re-encoded', async () => {
    const r = await canonicalise(FIXTURES.blender(checker(2560, 64)));
    const { json, bin } = parseGlb(r.glb);
    const view = json.bufferViews[json.images[0].bufferView];
    const bytes = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    assert.deepEqual(imageInfo(bytes), { mime: 'image/png', width: 2048, height: 51 });
    assert.notEqual(r.san, (await canonicalise(FIXTURES.blender(checker(64)))).san,
        'a different texture is a different asset');
    assert.equal(r.san, (await canonicalise(FIXTURES.blender(checker(2560, 64)))).san,
        'and the shrink is reproducible');
});

test('the PNG codec round-trips, and encodes the same bytes every time', async () => {
    const rgba = new Uint8Array(16 * 8 * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
    const png = encodePng(rgba, 16, 8);
    assert.deepEqual(imageInfo(png), { mime: 'image/png', width: 16, height: 8 });
    const back = await decodePng(png);
    assert.deepEqual(Array.from(back.data), Array.from(rgba));
    assert.deepEqual(Array.from(encodePng(rgba, 16, 8)), Array.from(png));
});

test('a box resize averages the pixels it covers', () => {
    const src = Uint8Array.from([0, 0, 0, 0, 100, 100, 100, 100,
        200, 200, 200, 200, 40, 40, 40, 40]);
    assert.deepEqual(Array.from(boxResize(src, 2, 2, 1, 1)), [85, 85, 85, 85]);
});

test('a GLB the canon cannot read is refused, not guessed at', async () => {
    await assert.rejects(() => canonicalise(new Uint8Array(64)), /not a GLB/);
    const empty = FIXTURES.blender(checker(8));
    const { json } = parseGlb(empty);
    json.meshes[0].primitives[0].mode = 1;
    const { buildGlb } = await import('../lib/glb.js');
    await assert.rejects(() => canonicalise(buildGlb(json, parseGlb(empty).bin)),
        /mode 1 is not triangles/);
});
