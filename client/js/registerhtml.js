// registerhtml.js — Marketplace › Register: putting a model on sale in four
// steps (TASKS-ui.md UI.5).
//
// The same forms the catalog's one long page had, ids and all (catalogui.js,
// catalogupload.js and catalogtypes.js fill them), split into the four things a
// maker actually does in order: bring the model, say what moves and what sets
// it off, name and price it, and register it. The stepper at the top is the
// way between them; nothing is lost by going back.

export const STEPS = [
    { id: 'model', words: 'Model' },
    { id: 'parts', words: 'Parts' },
    { id: 'price', words: 'Name & price' },
    { id: 'done', words: 'Register' },
];

export const REGISTER_HTML = `
<section id="upload" class="rg" hidden>
  <nav class="rg-steps" aria-label="steps">
    ${STEPS.map((s, i) => `<button type="button" class="rg-step" data-step="${s.id}">
      <span class="n">${i + 1}</span>${s.words}</button>`).join('')}
  </nav>
  <div class="rg-look">
    <canvas class="preview" id="preview" width="512" height="512"></canvas>
    <div id="already" class="muted"></div>
  </div>
  <div class="rg-page" data-page="model">
    <label for="upload-type" class="label">What it is</label>
    <select id="upload-type"></select>
    <div id="form-model">
      <label class="rg-drop">
        <span>Drop a .glb here, or choose one</span>
        <input id="file" type="file" accept=".glb,model/gltf-binary">
      </label>
      <div id="canon" class="muted mono"></div>
      <div id="near"></div>
      <div class="note">Canonicalised in this tab: the same model from two tools is one
        product.</div>
    </div>
    <div id="form-material" hidden>
      <input id="material-file" type="file" accept=".png,image/png">
      <label for="material-tiling">Tiling — metres of ground per tile</label>
      <input id="material-tiling" type="number" min="0.05" step="0.05" value="4">
      <canvas class="preview" id="material-preview" width="256" height="256"></canvas>
      <div id="material-said" class="muted mono"></div>
    </div>
    <div id="form-file" hidden>
      <input id="product-file" type="file" accept=".tar,.elx,application/x-tar">
      <div id="product-said" class="muted mono"></div>
      <div class="note">A plugin is its folder as a .tar; a flow is its .elx.</div>
    </div>
    <div id="form-profile" hidden></div>
    <div id="form-collection" hidden></div>
  </div>
  <div class="rg-page" data-page="parts" hidden>
    <p class="note">Click a part of the model, then say what it does: lights up, shows a
      picture, moves. Below it: what sets it off, and whether it may be carried.</p>
    <div id="form-parts" hidden></div>
    <p class="rg-none note">Nothing to mark on this kind of product.</p>
  </div>
  <div class="rg-page" data-page="price" hidden>
    <label for="name" class="label">Name others see</label>
    <input id="name" type="text" autocomplete="off" placeholder="Name">
    <div class="row">
      <label class="label">Category<select id="upload-category"></select></label>
      <label class="label">Licence<select id="upload-license"></select></label>
    </div>
    <div class="row">
      <label class="label">Price each
        <input id="price" type="number" min="0" step="0.01" value="0"></label>
      <label class="label">Editions
        <input id="editions" type="number" min="1" step="1" placeholder="unlimited"></label>
    </div>
    <label for="upload-policy" class="label">Sold as</label>
    <select id="upload-policy">
      <option value="once">bought once — keeps its version, receives fixes</option>
      <option value="subscription">a subscription — updates while paid, 30 days</option>
      <option value="pinned">this exact version, for good</option>
    </select>
    <label class="label rg-off" title="Comes with the new payment system">Earnings go to
      <select disabled><option>Your wallet</option></select></label>
  </div>
  <div class="rg-page" data-page="done" hidden>
    <dl class="rg-sum"></dl>
    <button id="publish" type="button" class="primary" disabled>Register</button>
    <p class="note">0 is free to place. Buyers get a licence to place one copy each; the
      model stays yours.</p>
  </div>
  <p id="upload-status" class="status"></p>
  <div class="rg-nav row">
    <button type="button" class="rg-back">Back</button>
    <button type="button" class="rg-next primary">Next</button>
  </div>
</section>`;

// The stepper: which page is showing, Back and Next, and the summary the last
// page reads out before Register.
export function mountSteps(doc) {
    const root = doc.getElementById('upload');
    const pages = [...root.querySelectorAll('.rg-page')];
    const buttons = [...root.querySelectorAll('.rg-step')];
    let at = 0;
    const value = (id) => doc.getElementById(id)?.value ?? '';
    const summary = () => {
        const rows = [['What', doc.getElementById('upload-type').selectedOptions[0]?.text],
            ['Canon', doc.getElementById('canon').textContent || '—'],
            ['Name', value('name') || '—'], ['Category', value('upload-category')],
            ['Licence', value('upload-license')], ['Price', value('price') || '0'],
            ['Sold as', doc.getElementById('upload-policy').selectedOptions[0]?.text]];
        root.querySelector('.rg-sum').replaceChildren(...rows.flatMap(([k, v]) =>
            [Object.assign(doc.createElement('dt'), { textContent: k }),
                Object.assign(doc.createElement('dd'), { textContent: v ?? '' })]));
    };
    const go = (i) => {
        at = Math.max(0, Math.min(STEPS.length - 1, i));
        pages.forEach((p, n) => { p.hidden = n !== at; });
        buttons.forEach((b, n) => {
            b.setAttribute('aria-current', String(n === at));
            b.dataset.done = n < at ? '1' : '';
        });
        const marked = !doc.getElementById('form-parts').hidden;
        // The model stays in view beside every step: its parts are marked by
        // looking at it, and it is what the name and the price are for.
        root.querySelector('.rg-look').hidden = doc.getElementById('form-model').hidden;
        root.querySelector('.rg-none').hidden = marked;
        root.querySelector('.rg-back').disabled = at === 0;
        root.querySelector('.rg-next').hidden = at === STEPS.length - 1;
        if (STEPS[at].id === 'done') summary();
    };
    buttons.forEach((b, n) => { b.onclick = () => go(n); });
    root.querySelector('.rg-back').onclick = () => go(at - 1);
    root.querySelector('.rg-next').onclick = () => go(at + 1);
    // Another kind of product has another form; the step it is on is drawn
    // again once catalogui.js has swapped them.
    doc.getElementById('upload-type').addEventListener('change',
        () => Promise.resolve().then(() => go(at)));
    go(0);
    return { go: (id) => go(STEPS.findIndex((s) => s.id === id)), at: () => STEPS[at].id };
}
