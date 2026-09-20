// symbolhtml.js — the markup of Settings · Symbols, and the two small pieces
// of it that are their own behaviour: the apply strip along the top, and the
// head of the symbol being edited.
//
// Split out of client/js/symbolsui.js so both stay under the four hundred
// lines CLAUDE.md allows. Nodes and one sentence each; symbolsui.js decides
// everything and does all the asking.

// Four columns under one strip. The strip is the panel's own answer to "is
// what I am looking at what the world is built with", so it is above the
// columns rather than tucked under the list — it is about all of them.
export const HTML = `
<div class="sy-apply-box spread">
  <p class="muted sy-changed"></p>
  <div class="row">
    <button type="button" class="sy-apply primary" disabled>Apply to world</button>
  </div>
  <div class="sy-confirm" hidden>
    <p class="sy-confirm-said"></p>
    <input class="sy-note" placeholder="a note, if you like">
    <div class="row">
      <button type="button" class="sy-really primary">Yes, apply it</button>
      <button type="button" class="sy-not">Cancel</button>
    </div>
  </div>
</div>
<div class="sy-cols">
  <div class="sy-left"></div>
  <div class="sy-mid">
    <div class="sy-head spread">
      <input class="sy-name" placeholder="Kantonsstrasse">
      <span class="muted sy-of"></span>
      <button type="button" class="sy-more-btn link">kind and order</button>
    </div>
    <div class="sy-more row" hidden>
      <label>Applies to <select class="sy-kind"></select></label>
      <label>Order <input type="number" class="sy-order" value="100"></label>
    </div>
    <div class="spread sy-when-head">
      <span class="label">When</span>
      <span class="muted">all of these have to hold</span>
    </div>
    <div class="sy-conds"></div>
    <div class="spread sy-when-foot">
      <button type="button" class="sy-add-cond">Add condition</button>
      <span class="muted sy-matches"></span>
    </div>
    <div class="sy-layers"></div>
    <div class="spread sy-save-row">
      <button type="button" class="sy-save primary">Save this symbol</button>
      <span class="muted">Saved versions do not reach the world until Apply.</span>
    </div>
    <p class="sy-status status"></p>
  </div>
  <div class="sy-right">
    <div class="spread">
      <span class="label">Preview</span>
      <span class="muted sy-sample">a sample of this kind, on a gentle slope</span>
    </div>
    <div class="sy-preview-box">
      <canvas class="sy-preview preview" width="256" height="256"></canvas>
      <span class="sy-preview-how">orbit · drag</span>
      <span class="sy-preview-by">compiled here, by lib/gen/</span>
    </div>
    <p class="muted sy-said"></p>
    <span class="label">Try values on the sample</span>
    <div class="sy-try-box"></div>
    <div class="sy-history"></div>
  </div>
</div>`;

// Applying rebuilds published tiles, so it asks once with the number on it.
export function applyBox(ui, { onApply, saidOf }) {
    const q = ui.q;
    q('.sy-apply').onclick = () => {
        const tiles = ui.state.changed.reduce((n, c) => Math.max(n, c.tiles ?? 0), 0);
        q('.sy-confirm-said').textContent =
            `${saidOf(ui.state.changed)} would go into the world, and`
            + ` ${tiles} published tile(s) would be rendered again.`;
        q('.sy-confirm').hidden = false;
    };
    q('.sy-not').onclick = () => { q('.sy-confirm').hidden = true; };
    q('.sy-really').onclick = onApply;
}

// The head of the symbol being edited. What it is about and who it beats are
// still fields — they are simply not worth three lines of the column they were
// taking, now that the list says the kind and the order is dragged.
export function headRow(ui, onChange) {
    const more = ui.q('.sy-more');
    ui.q('.sy-more-btn').onclick = () => { more.hidden = !more.hidden; };
    for (const sel of ['.sy-kind', '.sy-order']) {
        ui.q(sel).addEventListener('change', onChange);
    }
}
