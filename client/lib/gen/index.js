// gen/index.js — what a drawn thing becomes, layer by layer.
//
// FND.7. A rule used to produce a bag of style values that the compiler knew
// how to read: `width` meant a road, `sides` meant a tree. A symbol produces a
// stack of layers instead, each one a thing that can be laid on a feature —
// a surface along a line, pieces repeated along it, models scattered over an
// area, an outline extruded. The compiler stops knowing what a road is.
//
// The filter and the value evaluator are still client/lib/rules.js's: a
// symbol matches the way a rule matched, and a layer's numbers may still be
// read off the feature ({"prop": "width", "else": 5}).
//
// Deterministic (Invariant 2): features arrive ordered by id, layers in the
// order the maker stacked them, and the meshes come out in one fixed order
// whatever order they were filled in.

import { matches, resolve } from '../rules.js';
import { Mesh } from '../mesh.js';

import * as surface from './surface.js';
import * as repeat from './repeat.js';
import * as scatter from './scatter.js';
import * as extrude from './extrude.js';
import * as place from './place.js';
import * as paint from './paint.js';
import * as check from './check.js';
import * as terrainmod from './terrainmod.js';

// The seven of PLAN-foundation.md §3, and the eighth that is on its way out:
// `terrainmod` is the old shaping operation, kept until FND.11 turns every
// one of them into a height edit.
export const LAYERS = { surface, repeat, scatter, extrude, place, paint, check, terrainmod };

// The order the meshes are written in, whatever order the features filled
// them. It is the order `assemble-v6` wrote them in, which is what lets a
// world compiled by the symbols be compared with one compiled by the rules.
export const MATERIALS = ['road', 'wall', 'roof', 'water', 'trunk', 'canopy'];

// The first enabled symbol of this kind whose filter holds — a symbol is
// matched exactly as a rule was (client/lib/rules.js).
export function symbolFor(symbols, feature) {
    for (const s of symbols ?? []) {
        if (s.enabled === false) continue;
        if (s.kind !== '*' && s.kind !== feature?.kind) continue;
        if (matches(s, feature?.props ?? {})) return s;
    }
    return null;
}

// A layer's parameters, with every value resolved against the feature.
export const paramsOf = (layer, feature) => {
    const out = {};
    for (const key of Object.keys(layer.params ?? {}).sort()) {
        const got = resolve(layer.params[key], feature?.props ?? {});
        if (got !== undefined && got !== null) out[key] = got;
    }
    return out;
};

// Where the layers draw. One Mesh per material for the whole tile, made when
// a layer first asks for it and handed out unchanged after that.
export function context(base) {
    const meshes = new Map();
    const extra = [];
    return {
        roads: [],
        roadsBy: new Map(),
        paints: [],
        trees: 0,
        radius: 6,
        asset: () => null,
        product: () => null,
        ...base,
        mesh(material) {
            if (!meshes.has(material)) meshes.set(material, new Mesh(material));
            return meshes.get(material);
        },
        // A mesh a layer built on its own — a placed model, which is its own
        // vertices rather than a share of a material's.
        add(mesh) { extra.push(mesh); },
        // The order of MATERIALS first, then anything a new layer invented,
        // in the order it was invented, then the models that were put down.
        drawn() {
            const named = MATERIALS.filter((m) => meshes.has(m));
            const rest = [...meshes.keys()].filter((m) => !MATERIALS.includes(m));
            return [...[...named, ...rest].map((m) => meshes.get(m)), ...extra];
        },
    };
}

const EMPTY = { boxes: [], flags: [], exclusions: [] };

// One feature through one symbol: every enabled layer, in stack order.
export function runSymbol(symbol, feature, ctx, phase = 'run') {
    const out = { boxes: [], flags: [], exclusions: [] };
    for (const layer of symbol?.layers ?? []) {
        if (layer.enabled === false) continue;
        // A layer of its own may ask a question the symbol did not: lamps
        // along this road, but only where it is lit.
        if (layer.when?.length && !matches({ filter: layer.when }, feature?.props ?? {})) {
            continue;
        }
        const run = LAYERS[layer.layer]?.[phase];
        if (!run) continue;
        const got = run(paramsOf(layer, feature), feature, ctx) ?? EMPTY;
        for (const key of ['boxes', 'flags', 'exclusions']) {
            if (got[key]?.length) out[key].push(...got[key]);
        }
    }
    return out;
}

/**
 * Every feature of a tile, through the symbol that matches it.
 *
 * Three passes over all of them, in PLAN-foundation.md §3's order, because
 * everything drawn stands on the ground the ones before it left: `shape`
 * moves the ground, `prepare` gathers the roads that are then cut into it,
 * and `run` draws.
 */
export function runAll(symbols, features, ctx) {
    const pairs = features.map((f) => [f, symbolFor(symbols, f)]).filter(([, s]) => s);
    for (const [f, s] of pairs) runSymbol(s, f, ctx, 'shape');
    for (const [f, s] of pairs) runSymbol(s, f, ctx, 'prepare');
    ctx.cut?.();
    const out = { boxes: [], flags: [], exclusions: [] };
    for (const [f, s] of pairs) {
        const got = runSymbol(s, f, ctx, 'run');
        for (const key of ['boxes', 'flags', 'exclusions']) out[key].push(...got[key]);
    }
    return { ...out, meshes: ctx.drawn() };
}
