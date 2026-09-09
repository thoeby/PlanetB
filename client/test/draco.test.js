// WP4.1 — KHR_draco_mesh_compression is undone before the canon looks at the
// file, so a compressed export of a model gets the same SAN as an uncompressed
// one. The fixture is built here rather than committed: it needs Google's
// encoder, and the test needs their decoder, so both come from `make vendor`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalise } from '../lib/canon.js';
import { dracoDecode, hasDraco } from '../lib/draco.js';
import { buildGlb, parseGlb, readAccessor, resolveBuffers } from '../lib/glb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '../vendor/draco');
const BENCH = join(HERE, 'fixtures/assets/blender.glb');

const ATTR = { POSITION: 'POSITION', NORMAL: 'NORMAL', TEXCOORD_0: 'TEX_COORD' };

// Re-encodes every primitive of a GLB with Draco, and replaces its accessors
// with the extension — what a glTF-Pipeline or Blender "compress" pass writes.
function compress(draco, bytes) {
    const { json, bin } = parseGlb(bytes);
    const buffers = resolveBuffers(json, bin);
    // The original BIN stays where it is — the texture still lives in it — and
    // the compressed meshes are appended after it.
    const parts = [bin];
    let at = bin.length;
    for (const prim of json.meshes[0].primitives) {
        const drc = encodeOne(draco, json, buffers, prim);
        const pad = (4 - (at % 4)) % 4;
        if (pad) { parts.push(new Uint8Array(pad)); at += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: drc.bytes.length });
        prim.extensions = { KHR_draco_mesh_compression: {
            bufferView: json.bufferViews.length - 1, attributes: drc.ids } };
        parts.push(drc.bytes);
        at += drc.bytes.length;
    }
    json.extensionsUsed = [...(json.extensionsUsed ?? []), 'KHR_draco_mesh_compression'];
    json.extensionsRequired = ['KHR_draco_mesh_compression'];
    const out = new Uint8Array(at);
    let cursor = 0;
    for (const p of parts) { out.set(p, cursor); cursor += p.length; }
    json.buffers = [{ byteLength: out.length }];
    return buildGlb(json, out);
}

function encodeOne(draco, json, buffers, prim) {
    const builder = new draco.MeshBuilder();
    const mesh = new draco.Mesh();
    const idx = Array.from(readAccessor(json, buffers, prim.indices));
    builder.AddFacesToMesh(mesh, idx.length / 3, new Uint32Array(idx));
    const ids = {};
    for (const [name, kind] of Object.entries(ATTR)) {
        const values = readAccessor(json, buffers, prim.attributes[name]);
        const n = name === 'TEXCOORD_0' ? 2 : 3;
        const id = builder.AddFloatAttributeToMesh(mesh, draco[kind],
            values.length / n, n, new Float32Array(values));
        ids[name] = id;
    }
    const encoder = new draco.Encoder();
    encoder.SetAttributeQuantization(draco.POSITION, 16);
    const buf = new draco.DracoInt8Array();
    const len = encoder.EncodeMeshToDracoBuffer(mesh, buf);
    assert.ok(len > 0, 'the draco encoder produced nothing');
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = buf.GetValue(i) & 255;
    draco.destroy(buf);
    draco.destroy(encoder);
    draco.destroy(mesh);
    draco.destroy(builder);
    // The extension names attributes by Draco unique id, which for a mesh built
    // here is the id the builder handed back.
    return { bytes, ids };
}

test('a Draco-compressed export canonicalises to the same asset', async (t) => {
    if (!existsSync(join(VENDOR, 'draco3d.js'))) {
        t.skip('no vendored draco — run `make vendor`');
        return;
    }
    const draco3d = createRequire(import.meta.url)(join(VENDOR, 'draco3d.js'));
    const encoder = await draco3d.createEncoderModule({});
    const decoder = await draco3d.createDecoderModule({});

    const plain = new Uint8Array(readFileSync(BENCH));
    const packed = compress(encoder, plain);
    assert.ok(hasDraco(parseGlb(packed).json), 'the fixture really is compressed');

    await assert.rejects(() => canonicalise(packed), /Draco-compressed and no decoder/,
        'without a decoder the upload is refused, not guessed at');

    const decoded = await canonicalise(packed, { decodeDraco: dracoDecode(decoder) });
    assert.equal(decoded.san, (await canonicalise(plain)).san);
    assert.equal(decoded.meta.tris, 36);
});
