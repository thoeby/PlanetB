// kinds.js — what a player may draw, read off the operator's vocabulary
// (PLAN-editors.md D4, idea 26; EDT.13, EDT.20).
//
// A kind is data: a row of `kind` with the geometry it is drawn as, and its
// class is the choice property of the same name (FND.3: `highway` is a
// `highway=residential`). The pickers offer one entry per kind and class —
// "highway · residential", "barrier · wall" — for the geometry in hand. No
// code per kind; the defaults below are the fallback until the operator gives
// a kind its own (EDT.23).

// A swatch per kind, the colours the editor has always drawn them in.
export const SWATCH = {
    highway: '#d8b84a', railway: '#9b8f7a', aerialway: '#b0b7c0', barrier: '#9aa4ad',
    waterway: '#4a8fc4', landuse: '#54a15a', natural: '#4a8fc4', building: '#d0794f',
};

// How wide a line of a class is, in metres, where nobody has said.
const WIDTH = {
    motorway: 12, trunk: 10, primary: 8, secondary: 7, tertiary: 6, unclassified: 5,
    residential: 5, service: 3.5, track: 3, path: 1.5, footway: 1.5, cycleway: 2, steps: 2,
    river: 12, stream: 2, canal: 6, ditch: 1, rail: 3, light_rail: 3, tram: 3,
    narrow_gauge: 2.5, funicular: 2.5, wall: 0.5, retaining_wall: 0.5, fence: 0.2,
    hedge: 1, guard_rail: 0.3, kerb: 0.2,
};
const KIND_WIDTH = { highway: 5, waterway: 2, barrier: 0.5, railway: 3, aerialway: 1 };

// How steep a line of a kind may be before its profile goes red, in percent.
const GRADIENT = { highway: 12, railway: 4, waterway: 100, barrier: 100, aerialway: 100 };
const CLASS_GRADIENT = { track: 16, path: 25, footway: 25, steps: 100, funicular: 60,
    motorway: 6, trunk: 7 };

// Walls and fences run straight between posts; roads and streams curve.
const CORNERED = new Set(['barrier']);

/**
 * The picker's entries for a geometry ('line' or 'polygon'): `kinds` are
 * rows of `kind`, `properties` rows of `property`, `defaults` what the
 * operator set per kind (EDT.23), keyed by kind name.
 */
export function entriesFor(geometry, kinds, properties, defaults = {}) {
    const out = [];
    for (const k of kinds.filter((r) => r.geometry === geometry && r.applies_to !== 'product')) {
        const own = defaults[k.name] ?? {};
        if (own.hidden) continue;
        const cls = properties.find((p) => p.kind === k.name && p.name === k.name);
        const values = cls?.choices?.length ? cls.choices : [null];
        for (const value of values) {
            const width = own.width ?? WIDTH[value] ?? KIND_WIDTH[k.name] ?? 2;
            out.push({
                id: value ? `${k.name}:${value}` : k.name, kind: k.name, value,
                words: value ? `${k.name} · ${value.replace(/_/g, ' ')}` : k.label || k.name,
                swatch: own.swatch ?? SWATCH[k.name] ?? '#9aa4ad',
                width, corner: own.corner ?? CORNERED.has(k.name),
                gradient: own.gradient ?? CLASS_GRADIENT[value] ?? GRADIENT[k.name] ?? 100,
                says: own.says ?? says(geometry, k.label || k.name, width),
                props: value ? { [k.name]: value } : {},
            });
        }
    }
    return out;
}

/**
 * Rows of `kind_default` (db/0199) as `entriesFor`'s defaults: only what the
 * operator said, so a blank width still falls back to the class's own.
 * `extra` is merged under them.
 */
export function defaultsFrom(rows = [], extra = {}) {
    const out = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { ...v }]));
    for (const r of rows ?? []) {
        const own = { ...(out[r.kind] ?? {}) };
        for (const k of ['width', 'corner', 'gradient']) if (r[k] != null) own[k] = r[k];
        if (r.hidden) own.hidden = true;
        out[r.kind] = own;
    }
    return out;
}

// What the editors guess for a kind nobody has set, for the admin's fields.
export const guessOf = (kind) => ({ width: KIND_WIDTH[kind] ?? 2,
    corner: CORNERED.has(kind), gradient: GRADIENT[kind] ?? 100 });

const says = (geometry, label, width) => (geometry === 'line'
    ? `${label.toLowerCase()}, ${width} m wide` : `an area of ${label.toLowerCase()}`);

/**
 * The entries in the order the picker shows them: recent first (most recent
 * on top), then the rest as the vocabulary orders them, filtered by what was
 * typed.
 */
export function ordered(entries, recent = [], typed = '') {
    const t = typed.trim().toLowerCase();
    const hit = (e) => !t || e.words.toLowerCase().includes(t) || e.id.includes(t);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const first = recent.map((id) => byId.get(id)).filter((e) => e && hit(e));
    const seen = new Set(first.map((e) => e.id));
    return [...first, ...entries.filter((e) => hit(e) && !seen.has(e.id))];
}

// The recent list after `id` is picked: it goes on top, nine at most.
export const touched = (recent, id) => [id, ...recent.filter((r) => r !== id)].slice(0, 9);

// Which entry a stored feature is: its kind and the class it says.
export function entryOf(entries, kind, props = {}) {
    return entries.find((e) => e.kind === kind && e.value === (props?.[kind] ?? null))
        ?? entries.find((e) => e.kind === kind) ?? null;
}
