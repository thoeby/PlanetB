#!/usr/bin/env node
// The models the foundation stories are played with (TASKS-foundation.md
// FND.0). Twelve GLBs: two trees, a bush, a rock, a street lamp whose head is
// its own node, a billboard whose screen is its own node, a bus, a tunnel
// portal whose mouth is its own node, a bridge deck, a 2 m wall segment, a
// 1 m kerb segment, and five centimetres of one that is too short to repeat.
//
// They are written here rather than downloaded: every CC0 model host is
// outside this container's egress policy, and a fixture that cannot be
// re-made is not a fixture. They are plain boxes and prisms at the right
// sizes, which is what the stories measure — a segment's repeat length, a
// part's node name, an opening's footprint — and they are deterministic, so
// anything hashed from them stays hashable.
//
//   node tools/make-fixture-models.mjs
//
// Sizes are metres, Y up, standing on y = 0, facing -Z.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { box, merge, model, pyramid } from './glbkit.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)),
    '../client/test/fixtures/assets');

const mat = (name, rgb, extra = {}) => ({
    name,
    pbrMetallicRoughness: {
        baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.8, ...extra,
    },
});

const BARK = mat('Bark', [0.28, 0.2, 0.13]);
const NEEDLE = mat('Needle', [0.13, 0.31, 0.16]);
const LEAF = mat('Leaf', [0.31, 0.44, 0.18]);
const STONE = mat('Stone', [0.55, 0.54, 0.5]);
const STEEL = mat('Steel', [0.55, 0.56, 0.58],
    { metallicFactor: 1, roughnessFactor: 0.35 });
const GLASS = mat('Lamp glass', [0.95, 0.93, 0.8]);
const PANEL = mat('Panel', [0.1, 0.1, 0.12]);
const PAINT = mat('Paint', [0.75, 0.2, 0.15]);
const CONCRETE = mat('Concrete', [0.62, 0.61, 0.58]);

// --------------------------------------------------------------- the eleven

// A fir: a trunk and two skirts of needles. 14 m, as the collection of FND.5
// weighs it against the larch.
const fir = () => [
    { name: 'trunk', mesh: box([-0.18, 0, -0.18], [0.18, 3.2, 0.18]), material: 0 },
    { name: 'canopy', mesh: merge(pyramid(2.1, 2.1, 2.6, 5.4, 0.35),
        pyramid(1.4, 1.4, 7.4, 6.6, 0.05)), material: 1 },
];

// A larch: taller trunk, a looser crown, broad enough to tell apart in a
// screenshot from the fir beside it.
const larch = () => [
    { name: 'trunk', mesh: box([-0.22, 0, -0.22], [0.22, 5.5, 0.22]), material: 0 },
    { name: 'canopy', mesh: pyramid(2.6, 2.6, 4.8, 11.2, 0.15), material: 1 },
];

const bush = () => [
    { name: 'bush', mesh: merge(pyramid(0.8, 0.8, 0, 1.1, 0.6),
        pyramid(0.5, 0.5, 0.9, 0.6, 0.2)), material: 0 },
];

const rock = () => [
    { name: 'rock', mesh: merge(pyramid(1.1, 0.9, 0, 0.9, 0.55),
        box([-0.6, 0.85, -0.5], [0.55, 1.15, 0.45])), material: 0 },
];

// The street lamp of FND.6: `head` is a node of its own, so that marking it
// as a light leaves a mesh named part:head behind under canon-v2.
const lamp = () => [
    { name: 'base', mesh: box([-0.22, 0, -0.22], [0.22, 0.35, 0.22]), material: 0 },
    { name: 'mast', mesh: merge(box([-0.08, 0.3, -0.08], [0.08, 6.0, 0.08]),
        box([-0.08, 5.85, -0.9], [0.08, 6.0, 0.08])), material: 0 },
    { name: 'head', mesh: box([-0.22, 5.7, -1.15], [0.22, 5.9, -0.6]), material: 1 },
];

// The billboard of FND.6: `screen` is the face, and only the face.
const billboard = () => [
    { name: 'posts', mesh: merge(box([-1.7, 0, -0.12], [-1.45, 3.2, 0.12]),
        box([1.45, 0, -0.12], [1.7, 3.2, 0.12])), material: 0 },
    { name: 'frame', mesh: box([-2.0, 3.1, -0.14], [2.0, 5.4, 0.14]), material: 0 },
    { name: 'screen', mesh: box([-1.9, 3.2, -0.16], [1.9, 5.3, -0.14]), material: 1 },
];

const bus = () => [
    { name: 'body', mesh: box([-1.28, 0.45, -6.0], [1.28, 3.1, 6.0]), material: 0 },
    { name: 'glass', mesh: box([-1.3, 1.85, -5.9], [1.3, 2.7, 5.9]), material: 1 },
    { name: 'wheels', mesh: merge(box([-1.3, 0, -4.4], [1.3, 0.5, -3.4]),
        box([-1.3, 0, 3.2], [1.3, 0.5, 4.2])), material: 2 },
];

// The tunnel portal of FND.6 and FND.11: `mouth` is the hole. Its footprint —
// the box projected down — is where the terrain opens, so it is a solid node
// that stands for the empty space, not a frame.
const portal = () => [
    { name: 'wall', mesh: merge(box([-4.5, 0, -0.6], [-2.6, 6.2, 0.6]),
        box([2.6, 0, -0.6], [4.5, 6.2, 0.6]),
        box([-4.5, 5.4, -0.6], [4.5, 7.0, 0.6])), material: 0 },
    { name: 'mouth', mesh: box([-2.6, 0, -0.6], [2.6, 5.4, 0.6]), material: 1 },
];

const bridgeDeck = () => [
    { name: 'deck', mesh: box([-4.0, 0, -6.0], [4.0, 0.45, 6.0]), material: 0 },
    { name: 'parapet', mesh: merge(box([-4.0, 0.45, -6.0], [-3.7, 1.35, 6.0]),
        box([3.7, 0.45, -6.0], [4.0, 1.35, 6.0])), material: 1 },
];

// The two segments of FND.5. The repeat length is the extent in X, so these
// are laid along X and the story reads "repeats every 2.00 m" off the file.
const wall2m = () => [
    { name: 'wall', mesh: merge(box([-1.0, 0, -0.25], [1.0, 1.1, 0.25]),
        box([-1.0, 1.1, -0.3], [1.0, 1.22, 0.3])), material: 0 },
];

const kerb1m = () => [
    { name: 'kerb', mesh: box([-0.5, 0, -0.15], [0.5, 0.12, 0.15]), material: 0 },
];

// Five centimetres of it: too short to be a repeat at all, which is what
// story 20's refusal is about.
const pebble5cm = () => [
    { name: 'pebble', mesh: box([-0.025, 0, -0.04], [0.025, 0.05, 0.04]), material: 0 },
];

const MODELS = [
    ['tree-fir', fir, [BARK, NEEDLE]],
    ['tree-larch', larch, [BARK, LEAF]],
    ['bush', bush, [LEAF]],
    ['rock', rock, [STONE]],
    ['street-lamp', lamp, [STEEL, GLASS]],
    ['billboard', billboard, [STEEL, PANEL]],
    ['bus', bus, [PAINT, GLASS, PANEL]],
    ['tunnel-portal', portal, [CONCRETE, PANEL]],
    ['bridge-deck', bridgeDeck, [CONCRETE, STEEL]],
    ['wall-segment-2m', wall2m, [STONE]],
    ['kerb-segment-1m', kerb1m, [CONCRETE]],
    ['pebble-segment-5cm', pebble5cm, [STONE]],
];

mkdirSync(OUT, { recursive: true });
for (const [name, parts, materials] of MODELS) {
    const bytes = model(parts(), materials);
    writeFileSync(join(OUT, `${name}.glb`), bytes);
    console.log(`${name}.glb  ${bytes.length} bytes  ${parts().length} node(s)`);
}
console.log(`make-fixture-models: ${MODELS.length} models → ${OUT}`);
