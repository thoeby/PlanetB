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

const HTML = `
<div class="row">
  <input id="q" type="search" placeholder="search by name">
  <button id="refresh" type="button">Find</button>
</div>
<div class="row">
  <select id="category"></select>
  <select id="license"></select>
</div>
<ul id="results"></ul>
<p id="status" class="status"></p>
<section id="detail" hidden></section>
<section id="upload" hidden>
  <label>Register a product</label>
  <p class="muted">The GLB is canonicalised in this tab — flattened, re-centred,
    sorted, its extensions dropped — and the catalogue number comes from what
    comes out. Upload the same model twice, from two tools, and it is one entry.</p>
  <input id="file" type="file" accept=".glb,model/gltf-binary">
  <canvas class="preview" id="preview" width="256" height="256"></canvas>
  <div id="canon" class="muted mono"></div>
  <div id="near"></div>
  <label>Name</label>
  <input id="name" type="text" autocomplete="off">
  <div class="row">
    <select id="upload-category"></select>
    <select id="upload-license"></select>
  </div>
  <div class="row">
    <input id="price" type="number" min="0" step="0.01" value="0" placeholder="price">
    <input id="editions" type="number" min="1" step="1" placeholder="editions">
  </div>
  <div class="row">
    <button id="publish" type="button" class="primary" disabled>Register</button>
  </div>
  <p id="upload-status" class="status"></p>
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
