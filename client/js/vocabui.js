// vocabui.js — the nodes of Settings · Vocabulary: what a thing in this world
// may say about itself.
//
// Every kind and every property is a row in `kind` and `property`
// (db/0040_properties.sql). Nothing here is a list in code: the forms this
// tool draws, the ones QGIS shows, and the conditions a symbol matches on all
// read the same rows, so adding `leaf_type` here is adding it everywhere.
//
// The panel was a dropdown of kinds and a browser `prompt()` for a new one, in
// a part that takes the whole window. It is two columns now: the kinds on the
// left with what each is and how much of the world is one, and on the right
// the kind itself and its properties, every field of both editable — `put_kind`
// and `put_property` have taken a label and an ordering since db/0040 and the
// panel could set neither.
//
// Nodes only. client/js/adminui.js does the deciding and all the asking.

import { el } from './poolui.js';

export const TYPES = ['text', 'number', 'boolean', 'choice'];
export const GEOMETRIES = ['polygon', 'line', 'point'];
// What a kind may be about. A feature is drawn on the ground; the others are
// the world's own nouns, and mixing all of them into one dropdown was how a
// list of thirty read as a list of nothing.
export const APPLIES = ['feature', 'asset', 'area'];

export const HTML = `
<div class="vo-cols">
  <div class="vo-left">
    <div class="spread vo-head">
      <span class="label">Kinds</span>
      <button type="button" class="ad-newkind">New kind</button>
    </div>
    <form class="vo-new section" hidden>
      <div class="row">
        <label>Name<input class="vo-new-name" placeholder="kiosk" autocomplete="off"></label>
        <label>Shown as<input class="vo-new-label" placeholder="Kiosk"
          autocomplete="off"></label>
      </div>
      <div class="row">
        <label>About<select class="vo-new-applies"></select></label>
        <label>Drawn as<select class="vo-new-geom"></select></label>
        <button type="submit" class="primary">Add the kind</button>
        <button type="button" class="vo-new-not">Cancel</button>
      </div>
      <p class="note">A kind is a thing the world can hold: a wood, a wall, a
        kiosk. What people draw for it decides which QGIS layer it becomes.</p>
    </form>
    <ul class="vo-kinds"></ul>
  </div>
  <div class="vo-mid">
    <div class="vo-kind-head spread">
      <input class="vo-label" placeholder="Highway">
      <span class="muted vo-of"></span>
    </div>
    <div class="row vo-kind-fields">
      <label>Name<input class="vo-name mono" readonly></label>
      <label>Drawn as<select class="vo-geom"></select></label>
      <label>Order<input class="vo-order" type="number" value="100"></label>
      <button type="button" class="vo-save-kind">Save the kind</button>
    </div>
    <div class="spread vo-props-head">
      <span class="label">What one may say about itself</span>
      <span class="muted">These are the fields QGIS shows, and what a symbol
        may match on.</span>
    </div>
    <ul class="ad-props vo-props"></ul>
    <form class="vo-add section">
      <span class="label">Add a property</span>
      <div class="row">
        <input class="ad-name mono" type="text" placeholder="leaf_type" autocomplete="off">
        <input class="vo-add-label" type="text" placeholder="Leaf type" autocomplete="off">
        <select class="ad-type"></select>
        <label class="ad-req"><input class="ad-required" type="checkbox"> required</label>
        <button type="submit" class="ad-save primary">Add</button>
      </div>
      <input class="ad-choices" type="text" placeholder="broadleaved, needleleaved"
        autocomplete="off">
    </form>
    <p class="ad-status status"></p>
    <p class="note">What the compiler lays down where one of these is drawn is a
      symbol, in
      <button type="button" class="ad-to-symbols link">Settings · Symbols</button>.
    </p>
  </div>
</div>`;

const words = (p) => [p.type, p.required ? 'required' : null,
    p.choices?.length ? `${p.choices.length} choices` : null].filter(Boolean).join(' · ');

// One kind in the list: what it is called, what people draw for it, how many
// things it may say about itself, and how much of the world is one. The last
// is the answer to "is this kind used at all", which a dropdown never gave.
function kindRow(k, { at, onPick, count }) {
    const pick = el('button', { type: 'button', className: 'vo-kind' },
        el('b', { className: 'vo-kind-name', textContent: k.label || k.name }),
        el('span', { className: 'vo-kind-sub',
            textContent: [k.name, k.geometry, `${(k.properties ?? []).length} properties`]
                .filter(Boolean).join(' · ') }));
    pick.classList.toggle('picked', k.name === at);
    pick.onclick = () => onPick(k);
    const li = el('li', { className: 'vo-row' }, pick,
        el('span', { className: 'vo-count mono', textContent: count ?? '' }));
    li.dataset.kind = k.name;
    return li;
}

// One property, every field of it editable in place: the panel could add and
// remove and nothing else, so a typo in a label meant dropping the property
// and writing it again — and what is already written keeps a dropped property.
export function propRow(p, { onSave, onDrop }) {
    const label = el('input', { className: 'vo-p-label', value: p.label ?? '',
        placeholder: p.name });
    const type = el('select', { className: 'vo-p-type' });
    type.append(...TYPES.map((t) => new Option(t, t)));
    type.value = p.type ?? 'text';
    const choices = el('input', { className: 'vo-p-choices',
        value: (p.choices ?? []).join(', '), placeholder: 'one, two, three' });
    choices.hidden = type.value !== 'choice';
    type.onchange = () => { choices.hidden = type.value !== 'choice'; };
    const required = el('input', { type: 'checkbox', className: 'vo-p-req',
        checked: Boolean(p.required) });
    const order = el('input', { type: 'number', className: 'vo-p-order',
        value: String(p.ordering ?? 100) });
    const save = el('button', { type: 'button', className: 'vo-p-save',
        textContent: 'Save' });
    const drop = el('button', { type: 'button', className: 'vo-p-drop',
        textContent: 'Remove' });
    const row = el('li', { className: 'ad-prop vo-prop' },
        el('span', { className: 'mono vo-p-name', textContent: p.name }),
        label, type, el('label', { className: 'vo-p-reqbox' }, required, ' required'),
        order, save, drop,
        el('div', { className: 'vo-p-choicebox' }, choices),
        el('span', { className: 'muted vo-p-says', textContent: words(p) }));
    row.dataset.prop = p.name;
    save.onclick = () => onSave(p.name, {
        label: label.value.trim(), type: type.value,
        choices: type.value === 'choice'
            ? choices.value.split(',').map((c) => c.trim()).filter(Boolean) : [],
        required: required.checked, ordering: Number(order.value) || 100,
    });
    drop.onclick = () => onDrop(p);
    return row;
}

export function drawKinds(host, vocab, { at, onPick, counts }) {
    const by = new Map();
    for (const k of vocab) {
        const what = k.applies_to ?? 'feature';
        if (!by.has(what)) by.set(what, []);
        by.get(what).push(k);
    }
    host.replaceChildren(...[...by.entries()].flatMap(([what, kinds]) => [
        el('li', { className: 'vo-applies label', textContent: whatWord(what) }),
        ...kinds.map((k) => kindRow(k, { at, onPick, count: counts?.get(k.name) })),
    ]));
    if (!vocab.length) {
        host.append(el('li', { className: 'muted',
            textContent: 'nothing yet — a world with no vocabulary holds nothing' }));
    }
}

const WHAT = { feature: 'drawn on the ground', asset: 'products in the catalog',
    area: 'land' };

export const whatWord = (what) => WHAT[what] ?? what;

export function options(select, values, blank = null) {
    select.replaceChildren(...(blank === null ? [] : [new Option(blank, '')]),
        ...values.map((v) => new Option(v, v)));
    return select;
}
