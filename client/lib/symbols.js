// symbols.js — what a layer is, said once.
//
// FND.7. The Symbols editor builds a form from this, the compiler reads the
// parameters it names, and the refusals below are the same ones db/0161 says
// again when a symbol is saved (Invariant 6). One description, so a field the
// editor offers and a field the compiler reads cannot drift apart.

// A field is one of:
//   number  — a number, or {"prop": …} read off the feature
//   text    — a word
//   choice  — one of `of`
//   colour  — three numbers, 0..1
//   product — a catalogue number, of the type in `type` (FND.5)
export const LAYERS = [
    { id: 'surface', words: 'Surface', on: 'line · area',
        note: 'Laid on the ground along a line, or over an area.',
        fields: [
            { name: 'profile', kind: 'product', type: 'profile', label: 'Cross-section' },
            { name: 'width', kind: 'number', label: 'Width (m)', value: 5 },
            { name: 'lift', kind: 'number', label: 'Above the ground (m)', value: 0.06 },
        ] },
    { id: 'repeat', words: 'Repeat', on: 'line',
        note: 'A piece laid again and again along the line.',
        fields: [
            { name: 'segment', kind: 'product', type: 'segment', label: 'Repeating piece' },
            { name: 'model', kind: 'product', type: 'model', label: 'or a model' },
            { name: 'spacing', kind: 'number', label: 'Every (m)', value: 25 },
            { name: 'side', kind: 'choice', of: ['centre', 'left', 'right', 'both'],
                label: 'Side', value: 'centre' },
            { name: 'offset', kind: 'number', label: 'Off the centre (m)', value: 0 },
        ] },
    { id: 'scatter', words: 'Scatter', on: 'area',
        note: 'Models spread over the area, no two the same.',
        fields: [
            { name: 'collection', kind: 'product', type: 'collection', label: 'Collection' },
            { name: 'spacing', kind: 'number', label: 'At least apart (m)' },
            { name: 'max_slope', kind: 'number', label: 'Refuse above (%)' },
        ] },
    { id: 'extrude', words: 'Extrude', on: 'area',
        note: 'The outline pulled up, with a roof on it.',
        fields: [
            { name: 'height', kind: 'number', label: 'Height (m)', value: 6 },
            { name: 'roof', kind: 'choice', of: ['flat', 'gable', 'hip'], label: 'Roof',
                value: 'flat' },
        ] },
    { id: 'place', words: 'Place', on: 'point',
        note: 'One model, where the point is.',
        fields: [
            { name: 'model', kind: 'product', type: 'model', label: 'Model' },
            { name: 'yaw', kind: 'number', label: 'Turned (°)', value: 0 },
            { name: 'scale', kind: 'number', label: 'Scale', value: 1 },
        ] },
    { id: 'paint', words: 'Paint', on: 'area · line',
        note: 'A material over the ground rather than a thing standing on it.'
            + ' This is also what a class of the ground cover looks like.',
        fields: [
            { name: 'material', kind: 'product', type: 'material', label: 'Material' },
            { name: 'width', kind: 'number', label: 'Width (m)', value: 0 },
            { name: 'blend', kind: 'number', label: 'Soft border (m)', value: 1 },
            { name: 'tiling', kind: 'number', label: 'Material is (m) across', value: 4 },
            { name: 'noise', kind: 'number', label: 'Edge noise', value: 0 },
            // FND.12: rock shows through where it is steep, snow lies where it
            // is high. Two numbers on the class itself, not a biome system.
            { name: 'above_slope', kind: 'number', label: 'Only above slope (%)' },
            { name: 'above_height', kind: 'number', label: 'Only above (m)' },
        ] },
    { id: 'check', words: 'Check', on: 'line',
        note: 'Builds nothing; flags what cannot be built.',
        fields: [
            { name: 'width', kind: 'number', label: 'Across (m)', value: 5 },
            { name: 'max_cross_slope', kind: 'number', label: 'Steeper than (%)', value: 8 },
        ] },
];

export const layerNamed = (id) => LAYERS.find((l) => l.id === id) ?? null;

export const layerWords = (id) => layerNamed(id)?.words ?? id;

// Every field of every layer that names a product, and the type it has to be.
export const productFields = (id) =>
    (layerNamed(id)?.fields ?? []).filter((f) => f.kind === 'product');

/**
 * What is wrong with this stack, in the words the editor says.
 *
 * `typeOf(san)` answers what a catalogue number is — a model, a segment, a
 * profile, a collection or a material — or null when the page has not looked
 * it up. db/0161 asks the database the same question when the symbol is saved.
 */
export function layerTrouble(layers, typeOf = () => null) {
    for (const layer of layers ?? []) {
        const known = layerNamed(layer.layer);
        if (!known) return `there is no layer called ${layer.layer}`;
        for (const field of productFields(layer.layer)) {
            const san = layer.params?.[field.name];
            if (!san || typeof san !== 'string') continue;
            const type = typeOf(san);
            if (type && type !== field.type) {
                return `${known.words} needs a ${words(field.type)}, and ${san} is a ${
                    words(type)}`;
            }
        }
    }
    return null;
}

const WORDS = { model: 'model', segment: 'repeating piece',
    profile: 'road cross-section', collection: 'collection',
    material: 'surface material' };

const words = (type) => WORDS[type] ?? type;
