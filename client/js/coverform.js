// coverform.js — the nodes of Settings · Ground cover: the four steps, the
// sources, and the table that says what each class in one of them is.
//
// FND.12. It was a wall of controls in two columns — an address, a user, a
// password, a connect, a layer, a priority, an add, a read, an attribute, a
// style download, a table of six unlabelled inputs and a save — with nothing
// saying which came first. It is four numbered steps now, and the table has
// headings: "Wald · landuse · forest" in three boxes with placeholders is not
// something anybody can read.
//
// Nodes only. client/js/coverui.js asks the GeoServer and the world.

import { el } from './poolui.js';

export const HTML = `
<div class="cv-cols">
  <div class="cv-left">
    <div class="spread cv-head">
      <span class="label">1 · Sources</span>
      <button type="button" class="cv-new">Add a source</button>
    </div>
    <p class="note">A cover source is a layer your GeoServer publishes as a
      picture, one flat colour per class. A raster of classes already is one; a
      vector layer is one once you publish it with the style in step 3.</p>
    <form class="cv-add-box section" hidden>
      <label>GeoServer<input class="cv-url"
        placeholder="the one in Setup, or another"></label>
      <div class="row">
        <input class="cv-user" placeholder="admin" autocomplete="off">
        <input class="cv-pw" type="password" placeholder="password"
          autocomplete="new-password">
        <button type="button" class="cv-connect">Ask it what it draws</button>
      </div>
      <div class="row">
        <label>Layer<select class="cv-layer">
          <option value="">connect first</option></select></label>
        <label>Priority<input class="cv-priority" type="number" value="0"></label>
        <button type="submit" class="cv-add primary">Add it</button>
        <button type="button" class="cv-add-not">Cancel</button>
      </div>
      <p class="note">Where two sources cover the same ground, the higher
        priority wins.</p>
      <p class="cv-status status"></p>
    </form>
    <ul class="cv-sources"></ul>
  </div>
  <div class="cv-mid">
    <div class="spread cv-mid-head">
      <span class="label">2 · Read what is in it</span>
      <span class="muted cv-which"></span>
    </div>
    <div class="row cv-read-row">
      <button type="button" class="cv-read">Read the classes</button>
      <label>Attribute<input class="cv-field" placeholder="OBJEKTART"></label>
      <button type="button" class="cv-sld">Download a style for GeoServer</button>
    </div>
    <p class="note">The classes are read off the ground the world has already
      cut for this source — the same picture the compiler reads. A vector
      layer has none until it is published with that style.</p>
    <div class="spread cv-map-head">
      <span class="label">3 · Say what each one is</span>
      <span class="muted cv-counted"></span>
    </div>
    <table class="cv-map">
      <thead><tr>
        <th></th><th>Colour</th><th>In the layer</th><th>Is a</th>
        <th>Property</th><th>Value</th><th>Of the ground</th>
      </tr></thead>
      <tbody></tbody>
    </table>
    <div class="spread cv-save-row">
      <button type="button" class="cv-save primary">4 · Keep this mapping</button>
      <span class="muted">A class you do not map is not shown, and nothing
        breaks. Kept is not applied: the world is built with it once somebody
        applies it in Symbols.</span>
    </div>
    <p class="cv-said status"></p>
  </div>
</div>`;

// One source: which layer it is, what it is worth against the others, and how
// much of it has been said. Picking one is what the right-hand side is about —
// it was a list here and a second dropdown over there, which could disagree.
export function sourceRow(s, { at, onPick, onDrop }) {
    const mapped = Object.keys(s.class_map ?? {}).length;
    const pick = el('button', { type: 'button', className: 'cv-source-pick' },
        el('b', { className: 'cv-source-name', textContent: s.layer }),
        el('span', { className: 'cv-source-sub',
            textContent: `priority ${s.priority} · ${mapped
                ? `${mapped} class${mapped === 1 ? '' : 'es'} mapped` : 'nothing mapped'}` }));
    pick.classList.toggle('picked', s.id === at);
    pick.onclick = () => onPick(s);
    const gone = el('button', { type: 'button', className: 'cv-drop',
        textContent: 'Remove' });
    gone.onclick = () => onDrop(s);
    const li = el('li', { className: 'cv-source-row' }, pick, gone);
    li.dataset.source = String(s.id);
    if (!mapped) li.dataset.bare = '1';
    return li;
}

// One class of one source. The colour as the raster carries it, what it is
// called in the layer, and the world's own words for what it is — a kind, a
// property and a value, which is what a symbol matches on (db/0040).
export function classRow(r, kinds, onChange) {
    const swatch = el('span', { className: 'cv-swatch' });
    swatch.style.background = r.colour;
    const kind = el('select', { className: 'cv-kind' });
    kind.replaceChildren(new Option('not shown', ''),
        ...kinds.map((k) => new Option(k.label || k.name, k.name)));
    kind.value = r.kind ?? '';
    const key = el('input', { className: 'cv-key', value: r.key ?? '',
        placeholder: 'landuse' });
    const value = el('input', { className: 'cv-value', value: r.value_of ?? '',
        placeholder: 'forest' });
    const source = el('input', { className: 'cv-src', value: r.value ?? '',
        placeholder: 'Wald' });
    for (const [node, field] of [[kind, 'kind'], [key, 'key'],
        [value, 'value_of'], [source, 'value']]) {
        node.onchange = () => { r[field] = node.value.trim(); onChange(); };
    }
    // How much of the ground this class is: it was counted and never shown, so
    // a colour that is nine tenths of the valley looked like one that is two
    // pixels of it.
    const seen = r.count ? `${Number(r.count).toLocaleString()} px` : '';
    const row = el('tr', { className: r.kind ? '' : 'cv-unmapped' },
        el('td', {}, swatch),
        el('td', { className: 'mono cv-colour', textContent: r.colour }),
        el('td', {}, source),
        el('td', {}, kind),
        el('td', {}, key),
        el('td', {}, value),
        el('td', { className: 'muted mono', textContent: seen }));
    row.dataset.colour = r.colour;
    return row;
}

export function emptyRow(words) {
    return el('tr', { className: 'cv-none' },
        el('td', { colSpan: 7, className: 'muted', textContent: words }));
}
