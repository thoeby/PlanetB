// sculptrail.js — the tool rail at the head of the Shape panel, and the small
// box of whatever the tool in hand needs (docs/design/splatworld-v11 11a).
//
// FND.9. The panel had a row of six word-buttons — "Raise (R)", "Along line
// (B)" — above every setting any of them might read, in a column beside the
// world. Which of the six was in hand was a shade of background; which of the
// settings it actually used, nothing said; and none of it was near the ground
// being shaped.
//
// So: a rail of glyphs, the one in hand lit, and under it one small box
// holding that tool's settings and nothing else. It hung over the world beside
// the panel until the panel itself became the narrow column beside the
// Blueprint clay (EDT.6); now it heads that column.
//
// Nodes only. client/js/sculptui.js decides; client/js/sculptmode.js says what
// each tool is for and which of the numbers it reads.

import { TOOLS, TOOL_ICON, BRUSH_SAYS } from './sculptmode.js';
import { el, icon } from './tabbar.js';

// The settings, all of them, in the one box. Which are on screen is the tool
// in hand's business (sculptui pickBrush, sculptmode brushUses): a field a
// tool does not read is not shown, rather than shown and ignored.
const OPTIONS = `
<div class="spread sc-opt-head">
  <span class="label sc-opt-name"></span>
  <span class="mono sc-opt-key"></span>
</div>
<p class="note sc-brush-says"></p>
<div class="sc-fields">
  <label data-uses="size">Size (m) <span class="mono muted">[ ]</span><input class="sc-size"
    type="number" min="1" max="200" value="12"></label>
  <label data-uses="strength">Strength (m/s)<input class="sc-strength" type="number"
    min="0.05" max="20" step="0.05" value="1"></label>
  <label data-uses="falloff">Falloff<input class="sc-soft" type="number" min="0" max="1"
    step="0.05" value="0.6"></label>
  <div data-uses="falloff" class="sc-curve-box">
    <svg class="sc-curve" viewBox="0 0 100 30" preserveAspectRatio="none"><path/></svg>
    <div class="sc-seg sc-curves">
      <button type="button" data-curve="smooth">Smooth</button>
      <button type="button" data-curve="linear">Linear</button>
      <button type="button" data-curve="sharp">Sharp</button>
      <button type="button" data-curve="plateau">Plateau</button>
    </div>
  </div>
  <div data-uses="shape" class="sc-seg sc-shapes">
    <button type="button" data-shape="circle">Circle</button>
    <button type="button" data-shape="square">Square</button>
  </div>
  <label data-uses="fall">Fall (%)<input class="sc-fall" type="number" min="0" max="5"
    step="0.5" value="0"></label>
  <label data-uses="fall">Falls towards (°)<input class="sc-dir" type="number" min="0"
    max="359" step="5" value="180"></label>
  <p data-uses="fall" class="note">Ctrl-drag on the ground turns the arrow.</p>
  <label data-uses="target">Level to (m)<input class="sc-target" type="number"
    step="0.5"></label>
  <div data-uses="target" class="sc-seg">
    <button type="button" class="sc-take">Take it from here</button>
    <select class="sc-floor"></select>
  </div>
  <p data-uses="target" class="note">Alt-click on the ground takes its height.</p>
</div>
<div class="sc-line-box" hidden>
  <div class="note">Click the path out on the ground, or take one of this
    land's roads. The bed is written once.</div>
  <div class="spread">
    <span class="muted sc-corners">no corners yet</span>
    <button type="button" class="sc-line-clear">Again</button>
  </div>
  <select class="sc-road"></select>
  <div class="sc-line-fields">
    <label>Width (m)<input class="sc-width" type="number" min="1" value="7"></label>
    <label>Shoulder (m)<input class="sc-shoulder" type="number" min="0" value="1"></label>
    <label>Gradient (%)<input class="sc-gradient" type="number" min="1" value="8"></label>
  </div>
  <button type="button" class="sc-apply primary">Lay the bed</button>
</div>
`;

// What can be done to the ground, as glyphs beside the tools: undo, redo,
// save, and back to the elevation. They were three wide buttons and a fourth
// wider one down the panel, which is a lot of chrome for four verbs you press
// with a hand already on the rail.
//
// The classes are the ones the panel used, because they are what the stories
// press (client/test/run/24-sculpt.spec.js) and what sculptui wires.
const DEEDS = [
    { cls: 'sc-undo', words: 'Undo', key: 'Ctrl-Z',
        icon: 'M3 10h11a5 5 0 0 1 0 10h-4|m3 10 5-5|m3 10 5 5' },
    { cls: 'sc-redo', words: 'Redo', key: 'Ctrl-Shift-Z',
        icon: 'M21 10H10a5 5 0 0 0 0 10h4|m21 10-5-5|m21 10-5 5' },
    { cls: 'sc-save', words: 'Save the ground', key: '',
        icon: 'M5 4h11l3 3v13H5z|M8 4v6h7V4|M8 20v-6h8v6' },
    { cls: 'sc-clear', words: 'Put the ground back as the elevation gave it', key: '',
        icon: 'M4 6h16|M4 12h10|M4 18h16|m20 9 3 3-3 3' },
];

function deedButton(d) {
    const b = el('button', { type: 'button', className: `sc-deed ${d.cls}`,
        title: d.key ? `${d.words} \u00b7 ${d.key}` : d.words },
    icon(d.icon));
    b.setAttribute('aria-label', d.words);
    return b;
}

// One tool: its glyph, its key, and what it is for under the pointer. The
// class carries the tool's id because the stories press `.sc-brush-line`
// (client/test/run/24-sculpt.spec.js) and because the rail lights one of them.
function toolButton(t, onPick) {
    const b = el('button', { type: 'button', className: `sc-brush sc-brush-${t.id}`,
        title: `${t.words} · ${t.key.toUpperCase()}\n${BRUSH_SAYS[t.id]?.does ?? ''}` },
    icon(TOOL_ICON[t.id] ?? ''), el('i', { className: 'sc-key', textContent:
        t.key.toUpperCase() }));
    b.dataset.brush = t.id;
    b.setAttribute('aria-label', t.words);
    b.onclick = () => onPick(t.id);
    return b;
}

// The toolbar over the world, top left, and its cards (the operator's note
// on EDT.6): the land, the tools at one fixed size with their keys, undo and
// redo, how much is unsaved, Save, Put back, and the Strokes card's toggle.
// The tool in hand's settings are a card that flaps out under the bar when a
// tool is picked, and folds away when it is picked again; the column down the
// left the panel was took a third of the screen for a few numbers.
export function toolRail(onPick, host) {
    const rail = el('div', { className: 'sc-rail' },
        ...TOOLS.map((t) => toolButton(t, onPick)));
    const [undo, redo, save, clear] = DEEDS.map(deedButton);
    save.append(el('span', { className: 'sc-save-words', textContent: 'Save' }));
    const strokes = el('button', { type: 'button', className: 'sc-deed sh-strokes-toggle',
        title: 'Strokes since the last save' }, icon('M4 6h16|M4 12h16|M4 18h10'));
    const land = el('select', { className: 'sc-land', title: 'The land being shaped' });
    const bar = el('div', { className: 'sc-bar glass' }, land, el('i', { className: 'sc-sep' }),
        rail, el('i', { className: 'sc-sep' }), undo, redo, el('i', { className: 'sc-sep' }),
        el('span', { className: 'sc-said' }), save, clear, strokes);
    const opt = el('div', { className: 'sc-opt glass' });
    opt.innerHTML = OPTIONS;
    const fold = el('button', { type: 'button', className: 'sc-fold', title: 'Fold the card away',
        textContent: '\u00d7' });
    opt.querySelector('.sc-opt-head').append(fold);
    const card = el('div', { className: 'sh-card glass', hidden: true });
    const node = el('div', { id: 'sculpt-tools', hidden: true }, bar,
        el('p', { className: 'sc-status status' }),
        el('button', { type: 'button', className: 'sc-retry', hidden: true,
            textContent: 'Retry the save' }),
        el('div', { className: 'sh-cards' }, opt, card));
    host.append(node);
    const folded = (yes) => { opt.hidden = yes; node.dataset.card = yes ? '' : '1'; };
    fold.onclick = () => folded(true);
    strokes.onclick = () => {
        card.hidden = !card.hidden;
        strokes.setAttribute('aria-pressed', String(!card.hidden));
    };
    return {
        node, card, folded,
        q: (sel) => node.querySelector(sel),
        all: (sel) => node.querySelectorAll(sel),
        // Which tool is in hand: lit on the bar, named over its card, and the
        // card flapped out — or, picked again, folded away.
        pick(id, { toggle = false } = {}) {
            const again = node.dataset.tool === id;
            for (const b of rail.children) {
                b.classList.toggle('picked', b.dataset.brush === id);
                b.setAttribute('aria-selected', String(b.dataset.brush === id));
            }
            const t = TOOLS.find((one) => one.id === id);
            node.dataset.tool = id;
            opt.querySelector('.sc-opt-name').textContent = t?.words ?? id;
            opt.querySelector('.sc-opt-key').textContent = t?.key.toUpperCase() ?? '';
            folded(toggle && again ? !opt.hidden : false);
        },
    };
}
