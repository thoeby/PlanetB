// FND.6 — canon-v2's acceptance: a model whose maker marked some of its nodes
// keeps those nodes as meshes of their own, and every model nobody marked is
// byte for byte what canon-v1 always made of it.
//
// The second half is the important one. canon-v1 named every product in the
// catalog (Invariant 1); if these bytes moved, every SAN in every world would
// move with them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalise } from '../lib/canon.js';
import { nodeNames } from '../lib/canonmesh.js';
import { buildGlb, parseGlb } from '../lib/glb.js';
import { meshesOf, placeMeshes } from '../lib/glbmesh.js';
import { canonMarks, marksTrouble, partNodes, portWords } from '../lib/marks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
    new Uint8Array(readFileSync(join(HERE, 'fixtures/assets', `${name}.glb`)));

// Every fixture's canon-v1 number, as it was before canon-v2 existed.
const V1 = {
    billboard: 'SXOUSXIHK3J2L',
    'blender-interleaved': 'SPUJCSX4KZLJL',
    blender: 'SPUJCSX4KZLJL',
    'bridge-deck': 'SXV2YSEWHJVOL',
    bus: 'SLTH6MAYO64G7',
    bush: 'SZC7RM6WT5XJB',
    'cad-split': 'SPUJCSX4KZLJL',
    cad: 'SPUJCSX4KZLJL',
    'kerb-segment-1m': 'SBNR7HF4XUVKR',
    'pebble-segment-5cm': 'SV2PI3XLDOD7F',
    rock: 'SFFO5KJLAVRSL',
    sketchfab: 'SPUJCSX4KZLJL',
    'street-lamp': 'SL2F6CHPT5HCU',
    'tree-fir': 'SPSC7UYG56NZ4',
    'tree-larch': 'STIOLKTSVDG27',
    'tunnel-portal': 'SGYJJURNSDZ47',
    'wall-segment-2m': 'SAUUINFOG3R3H',
};

const LAMP = { parts: [{ name: 'head', node: 'head', role: 'light' }],
    ports: [{ name: 'on', drives: { part: 'head' } }] };

test('an unmarked model is canon-v1, to the number it always had', async () => {
    for (const [name, san] of Object.entries(V1)) {
        const r = await canonicalise(fixture(name));
        assert.equal(r.canon_version, 1, name);
        assert.equal(r.san, san, `${name} is no longer ${san}`);
    }
});

test('a marked node stays a mesh of its own, named after the part', async () => {
    const marks = canonMarks(LAMP);
    const r = await canonicalise(fixture('street-lamp'), { parts: partNodes(marks) });
    assert.equal(r.canon_version, 2);
    // The number is the database's under canon-v2, because the same file with
    // other markings is another product (db/0160).
    assert.equal(r.san, null);
    const { json } = parseGlb(r.glb);
    assert.deepEqual(json.nodes, [{ mesh: 0 }, { mesh: 1, name: 'part:head' }]);
    const v1 = await canonicalise(fixture('street-lamp'));
    assert.equal(r.meta.tris, v1.meta.tris, 'no triangle was lost in the splitting');
    assert.deepEqual(r.meta.bbox, v1.meta.bbox);
    const parts = meshesOf(r.glb).map((m) => m.part);
    assert.deepEqual(parts, [null, 'head']);
    assert.equal(meshesOf(r.glb, { skip: new Set(['head']) }).length, 1);
    // What the compiler does with a part it must not bake: leaves it out
    // (client/atoms/assemble.js does this for a screen).
    const whole = placeMeshes(r.glb, { at: [0, 0, 0] });
    const without = placeMeshes(r.glb, { at: [0, 0, 0], skip: new Set(['head']) });
    assert.equal(whole.length, 2);
    assert.equal(without.length, 1);
});

// Two exporters differ in how they write a tree, not in what is in it: one
// spells a transform out on a wrapper, the other lists its children the other
// way round. Under the same markings the two land on one file.
function otherExporter(bytes) {
    const { json, bin } = parseGlb(bytes);
    const roots = json.scenes[json.scene ?? 0].nodes;
    json.nodes = json.nodes.map((n) => (roots.includes(json.nodes.indexOf(n))
        ? { ...n, translation: [-1, 0, 0] } : n));
    json.nodes.push({ children: [...roots].reverse(), translation: [1, 0, 0] });
    json.scenes[json.scene ?? 0] = { nodes: [json.nodes.length - 1] };
    return buildGlb(json, bin);
}

test('two exporters with the same markings write the same canonical file', async () => {
    const marks = partNodes(canonMarks(LAMP));
    const a = await canonicalise(fixture('street-lamp'), { parts: marks });
    const b = await canonicalise(otherExporter(fixture('street-lamp')), { parts: marks });
    assert.deepEqual(Array.from(b.glb), Array.from(a.glb));
});

test('the nodes on offer are the ones with something to draw', () => {
    const { json } = parseGlb(fixture('street-lamp'));
    assert.deepEqual(nodeNames(json), ['base', 'head', 'mast']);
});

test('a marking that points at nothing is refused before it is uploaded', () => {
    const nodes = ['base', 'head', 'mast'];
    assert.equal(marksTrouble(LAMP, nodes), null);
    assert.match(marksTrouble({ parts: [{ name: 'top', node: 'top', role: 'light' }] }, nodes),
        /no node called top/);
    assert.match(marksTrouble({ parts: [{ name: 'head', node: 'head' }] }, nodes),
        /head needs a role/);
    assert.match(marksTrouble({ ...LAMP,
        ports: [{ name: 'on', drives: { part: 'foot' } }] }, nodes),
    /on drives foot, which is not a part/);
});

test('a product says what it can be told', () => {
    assert.equal(portWords(LAMP), 'on (on/off)');
    assert.equal(portWords({}), '');
});
