// catalogpanel.js — the Catalog tab: products anyone may build with.
//
// The catalog itself is client/js/catalogui.js, which was a page of its own.
// This puts its markup into the tab and hands it over unchanged, so there is
// one catalog rather than two (TASKS-usable: no new pages).
//
// The categories and licences it offers are the `product` kind's properties
// (db/0040_properties.sql), so an admin decides them rather than a constant.

import * as api from './api.js';
import { mountCatalog } from './catalogui.js';

// The panel is one wide column rather than the artboard's two, because the
// chrome docks one panel at a time (client/js/hud.js) and a second floating
// column would cover the world it is about. Everything the artboard shows is
// here, in its order: find, the cards, then Register as three numbered steps.
const HTML = `
<div class="section">
  <span class="label">Find</span>
  <div class="row">
    <input id="q" type="search" placeholder="search by name, maker or property">
    <button id="refresh" type="button">Find</button>
  </div>
  <div class="row">
    <label>Kind of thing<select id="category"></select></label>
    <label>Licence<select id="license"></select></label>
  </div>
</div>
<ul id="results" class="cards"></ul>
<p id="status" class="status"></p>
<section id="detail" hidden></section>
<section id="upload" hidden>
  <div class="step" data-now="1">
    <span class="n">1</span>
    <div class="t">
      <span class="head">Model</span>
      <input id="file" type="file" accept=".glb,model/gltf-binary">
      <canvas class="preview" id="preview" width="256" height="256"></canvas>
      <div id="canon" class="muted mono"></div>
      <div id="near"></div>
      <div class="note">The GLB is canonicalised in this tab — flattened,
        re-centred, sorted, its extensions dropped — and the catalogue number
        comes from what comes out. Upload the same model twice, from two tools,
        and it is one entry.</div>
    </div>
  </div>
  <div class="step">
    <span class="n">2</span>
    <div class="t">
      <span class="head">Name and kind</span>
      <input id="name" type="text" autocomplete="off" placeholder="Name">
      <div class="row">
        <select id="upload-category"></select>
        <select id="upload-license"></select>
      </div>
      <div class="note">The kind decides which of the admin's properties this
        product has to fill in.</div>
    </div>
  </div>
  <div class="step">
    <span class="n">3</span>
    <div class="t">
      <span class="head">Price and editions</span>
      <div class="row">
        <input id="price" type="number" min="0" step="0.01" value="0"
          placeholder="cr per placement">
        <input id="editions" type="number" min="1" step="1"
          placeholder="editions — blank is unlimited">
      </div>
      <div class="note">0 is free to place. A number of editions makes it
        limited: that many placements exist, ever.</div>
      <button id="publish" type="button" class="primary" disabled>Register</button>
      <p id="upload-status" class="status"></p>
    </div>
  </div>
</section>`;

// The values a product may carry, as the admin defined them. A world whose
// admin has not defined `category` or `licence` still gets a working catalog:
// the fallbacks are what the starter vocabulary ships with.
export async function productChoices() {
    const kinds = await api.rpc('vocabulary', { applies_to: 'product' }).catch(() => []);
    const props = kinds?.[0]?.properties ?? [];
    const of = (name, fallback) => {
        const found = props.find((p) => p.name === name);
        return found?.choices?.length ? found.choices : fallback;
    };
    return {
        categories: of('category', ['prop', 'building', 'vegetation', 'other']),
        licences: of('licence', ['cc0', 'free', 'paid', 'limited']),
    };
}

export async function mountCatalogPanel(host, { mountAuth } = {}) {
    const box = document.createElement('div');
    box.innerHTML = HTML;
    host.append(box);
    const choices = await productChoices();
    const catalog = mountCatalog(document, { mountAuth, choices });
    return catalog;
}
