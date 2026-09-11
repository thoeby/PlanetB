// rules.js — what a feature becomes, decided by rules instead of by code.
//
// The same shape as QGIS's rule-based symbology: an ordered list, each rule a
// filter over the feature's own properties and a style it produces, first match
// wins. The rules live in `build_rule` (db/0036_rules.sql) and travel with the
// tile's world, so nothing here knows the name of a species, a roof or a column.
//
// Deterministic (Invariant 2): pure functions of the rules as the database
// ordered them and the feature's properties. No clock, no randomness, no
// iteration over object key order that the caller did not fix.

// prop op value, all of them true for the rule to match. A rule with no
// conditions is the "else" rule: put it last.
const OPS = {
    eq: (a, b) => same(a, b),
    ne: (a, b) => !same(a, b),
    lt: (a, b) => num(a) < num(b),
    lte: (a, b) => num(a) <= num(b),
    gt: (a, b) => num(a) > num(b),
    gte: (a, b) => num(a) >= num(b),
    in: (a, b) => (Array.isArray(b) ? b : [b]).some((v) => same(a, v)),
    has: (a, b) => text(a).includes(text(b)),
    exists: (a) => a !== undefined && a !== null && String(a).trim() !== '',
    missing: (a) => !(a !== undefined && a !== null && String(a).trim() !== ''),
};

const text = (v) => String(v ?? '').trim().toLowerCase();
// An absent property is not zero: "no height" must fall through to `else`,
// and Number('') is 0.
const num = (v) => {
    const t = String(v ?? '').trim().replace(',', '.');
    return t === '' ? NaN : Number(t);
};
// A layer says 'Fichte', a rule says 'fichte', a number may arrive as a string:
// compare as text unless both sides are numbers.
function same(a, b) {
    const [x, y] = [num(a), num(b)];
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
    return text(a) === text(b);
}

export function matches(rule, props) {
    for (const cond of rule.filter ?? []) {
        const op = OPS[cond.op ?? 'eq'];
        if (!op || !op((props ?? {})[cond.prop], cond.value)) return false;
    }
    return true;
}

// A style value is either a constant, or a number read off the feature:
//   {"prop": "hoehe", "times": 1, "plus": 0, "min": 2, "max": 80, "else": 6}
// `else` is used when the property is absent or not a number, and may itself
// be another such object — that is how "height, or storeys x 3, or 6" is said.
export function resolve(value, props) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (!('prop' in value)) return value;
    const raw = (props ?? {})[value.prop];
    // {"prop": "dachform", "text": true} — a word off the feature, for the
    // styles that are words: a roof shape, a terrain operation.
    if (value.text) {
        return String(raw ?? '').trim() ? String(raw).trim() : resolve(value.else, props);
    }
    let out = num(raw);
    if (!Number.isFinite(out)) return resolve(value.else, props);
    out = out * (value.times ?? 1) + (value.plus ?? 0);
    if (Number.isFinite(value.min)) out = Math.max(value.min, out);
    if (Number.isFinite(value.max)) out = Math.min(value.max, out);
    return out;
}

// The first rule that matches this feature, with every value resolved against
// its properties. No match is an empty style: the compiler's own default then
// stands, so an empty rule table still builds a world.
export function styleFor(rules, feature) {
    const props = feature?.props ?? {};
    for (const rule of rules ?? []) {
        if (rule.enabled === false) continue;
        if (rule.kind !== '*' && rule.kind !== feature?.kind) continue;
        if (!matches(rule, props)) continue;
        const out = {};
        for (const key of Object.keys(rule.style ?? {}).sort()) {
            const got = resolve(rule.style[key], props);
            if (got !== undefined && got !== null) out[key] = got;
        }
        out._rule = rule.name ?? rule.id;
        return out;
    }
    return {};
}
