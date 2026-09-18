// catalogui.js — the DOM half of catalog.html. Plain DOM, no framework.
//
// It owns the page and nothing else: searching, uploading and registering are
// catalog.js, and what a signed-in user may do is decided by row-level security
// (Invariant 6).

import * as api from './api.js';
import { buyAsset, myRights, offerOf } from './wallet.js';
import { CATEGORIES, LICENSES, TYPES, duplicatesOf, getAsset, glbUrl,
    prepare, publishAsset, searchAssets, thumbUrl, typeWords } from './catalog.js';
import { mountCollectionForm, mountProfileForm, paintMaterial, publishTyped }
    from './catalogtypes.js';
import { profileWidth, repeatsEvery, segmentTrouble, stripsOf } from '../lib/product.js';
import { empty } from './empty.js';

// A catalog with nothing in it is where every world starts, and the way out of
// it is the register form further down the same panel.
const nothingFound = () => empty('Nothing in the catalog',
    'A product is a model anybody may build with. Register one below and it is'
    + ' here for everybody to build with.', { as: 'li' });

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);

const options = (select, values, blank) => {
    select.innerHTML = '';
    for (const v of (blank ? ['', ...values] : values)) {
        select.append(new Option(v || blank, v));
    }
};

function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

// --------------------------------------------------------------------- list

function card(asset, onOpen) {
    const url = thumbUrl(asset);
    const shot = url
        ? el('img', { src: url, alt: asset.name, loading: 'lazy' })
        : el('div', { className: 'noshot' });
    const open = el('button', { type: 'button', textContent: asset.name });
    open.addEventListener('click', () => onOpen(asset.san));
    return el('li', {}, shot, el('div', { className: 'meta' },
        open,
        el('div', { className: 'san', textContent: asset.san }),
        el('div', { className: 'muted', textContent:
            `${typeWords(asset.type)} \u00b7 ${asset.category} \u00b7 ${asset.license}`
            + (asset.type === 'segment' ? ` \u00b7 ${repeatsEvery(asset.bbox)}`
                : asset.tris ? ` \u00b7 ${asset.tris} tris` : '') })));
}

// What a product of each type has to say about itself, beyond the rows every
// one of them has.
function typeRows(asset) {
    if (asset.type === 'segment') return [['repeat', repeatsEvery(asset.bbox)]];
    if (asset.type === 'material') {
        return [['tiling', `${asset.parts?.tiling ?? '?'} m per tile`]];
    }
    if (asset.type === 'profile') {
        const p = asset.parts?.profile;
        return [['strips', String(stripsOf(p).length)],
            ['across', `${profileWidth(p).toFixed(2)} m`],
            ['mirrored', p?.mirrored ? 'yes' : 'no']];
    }
    if (asset.type === 'collection') {
        return [['in it', String(asset.parts?.collection?.members?.length ?? 0)]];
    }
    return [];
}

function detailOf(asset) {
    const rows = [
        ['catalog number', asset.san],
        ['what it is', typeWords(asset.type)],
        ...typeRows(asset),
        ['category', asset.category],
        ['licence', asset.license === 'limited'
            ? `limited, ${asset.issued}/${asset.editions} issued` : asset.license],
        ['price', String(asset.price)],
        ['triangles', String(asset.tris)],
        ['textures', fmtBytes(asset.tex_bytes)],
        ['size', asset.bbox?.min ? asset.bbox.max.map((v, i) =>
            (v - asset.bbox.min[i]).toFixed(2)).join(' × ') + ' m' : 'unknown'],
        ['canon', `canon-v${asset.canon_version}`],
        ['sha256', asset.sha256],
    ];
    const dl = el('dl');
    for (const [k, v] of rows) {
        dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    }
    return dl;
}

// WP4.4: a licence is bought here. What it costs and whether there is one left
// is the asset's own business; buy_asset is one transaction and refuses the
// rest (Invariant 5), so the button only has to show what it said.
function buyButton(asset, held, status, reopen) {
    const offer = offerOf(asset, held.has(asset.san));
    const buy = el('button', { type: 'button', className: 'buy',
        textContent: offer.label, disabled: offer.state !== 'buy' || !api.claims() });
    buy.onclick = async () => {
        buy.disabled = true;
        try {
            await buyAsset(asset.san);
            held.add(asset.san);
            status.textContent = `licensed ${asset.san}`;
            await reopen(asset.san);
        } catch (err) {
            buy.textContent = String(err.body?.message ?? err.message ?? err);
        }
    };
    return buy;
}

// ------------------------------------------------------------------- upload

class Upload {
    constructor(doc, say) {
        this.doc = doc;
        this.say = say;
        this.canon = null;
        // The thumbnail is drawn off-screen, exactly as an atom would draw it,
        // and the visible preview is painted from the WebP that comes out — so
        // what the uploader sees is the file the catalog will serve.
        this.canvas = (w, h) => new OffscreenCanvas(w, h);
    }

    // canon-v1 runs before anything leaves the tab, so the uploader sees the
    // number and the near-duplicates before they commit to either.
    async pick(file) {
        this.canon = null;
        this.doc.getElementById('publish').disabled = true;
        if (!file) return;
        this.say('canonicalising…');
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            this.canon = await prepare(bytes, { canvas: this.canvas });
            this.show(file);
            await this.paint();
            this.say('');
        } catch (err) {
            this.doc.getElementById('canon').textContent = '';
            this.say(String(err.message ?? err), true);
        }
    }

    async paint() {
        const preview = this.doc.getElementById('preview');
        if (!this.canon?.thumb || !preview) return;
        const bitmap = await createImageBitmap(
            new Blob([this.canon.thumb], { type: 'image/webp' }));
        preview.getContext('2d').drawImage(bitmap, 0, 0, preview.width, preview.height);
    }

    show(file) {
        const c = this.canon;
        const size = c.meta.bbox.max.map((v, i) => (v - c.meta.bbox.min[i]).toFixed(2));
        this.doc.getElementById('canon').textContent =
            `${c.san} · ${c.meta.tris} tris · ${c.meta.materials} materials · `
            + `${fmtBytes(c.meta.tex_bytes)} of texture · ${size.join(' × ')} m · `
            + `${fmtBytes(file.size)} in, ${fmtBytes(c.glb.byteLength)} canonical`;
        const name = this.doc.getElementById('name');
        if (!name.value) name.value = file.name.replace(/\.glb$/i, '');
        this.doc.getElementById('publish').disabled = false;
        this.near(c.near);
    }

    near(rows) {
        const host = this.doc.getElementById('near');
        host.innerHTML = '';
        if (!rows?.length) return;
        const list = el('ul');
        for (const a of rows) {
            list.append(el('li', { textContent: `${a.san} — ${a.name} (${a.tris} tris)` }));
        }
        host.append(el('div', { className: 'near' },
            el('strong', { textContent: 'this looks like something already in the catalog' }),
            list));
    }

    meta() {
        const value = (id) => this.doc.getElementById(id).value;
        const license = value('upload-license');
        return {
            name: value('name'), category: value('upload-category'), license,
            type: value('upload-type') || 'model',
            price: Number(value('price')) || 0,
            editions: license === 'limited' ? Number(value('editions')) || 1 : null,
        };
    }

    async publish() {
        if (!this.canon) return null;
        const meta = this.meta();
        // A repeating piece is measured along X, and one that is too short to
        // repeat is refused here and again by db/0137 (Invariant 6).
        if (meta.type === 'segment') {
            const trouble = segmentTrouble(this.canon.meta.bbox);
            if (trouble) { this.say(trouble, true); return null; }
        }
        this.near(await duplicatesOf(meta.name, this.canon));
        this.say('uploading…');
        try {
            const san = await publishAsset(this.canon, meta);
            this.say(`published ${san}${meta.type === 'segment'
                ? ` \u00b7 ${repeatsEvery(this.canon.meta.bbox)}` : ''}`);
            return san;
        } catch (err) {
            this.say(String(err.message ?? err), true);
            return null;
        }
    }
}

// The five kinds of product (FND.5): one filter over the catalog, one choice
// at the top of Register.
function fillTypes(doc) {
    const filter = doc.getElementById('type');
    options(filter, TYPES.map((t) => t.id), 'any');
    for (const opt of filter.options) {
        if (opt.value) opt.textContent = typeWords(opt.value);
    }
    doc.getElementById('upload-type')
        .replaceChildren(...TYPES.map((t) => new Option(t.words, t.id)));
}

// ---------------------------------------------------------------- the forms

// Which of the five is being registered, and therefore which form is on
// screen and what Register does with it. A model and a repeating piece share
// the GLB form; the other three have one each.
function typeForms(doc, say) {
    const at = (id) => doc.getElementById(id);
    const material = { bytes: null, width: 0, height: 0, tiling: 4 };
    const profile = mountProfileForm(at('form-profile'));
    const collection = mountCollectionForm(at('form-collection'));

    const paint = async () => {
        if (!material.bytes) return;
        const size = await paintMaterial(at('material-preview'), material.bytes,
            at('material-tiling').value);
        Object.assign(material, size, { tiling: Number(at('material-tiling').value) });
        at('material-said').textContent =
            `${size.width} \u00d7 ${size.height} px \u00b7 ${material.tiling} m per tile`;
    };
    at('material-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        material.bytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
        const name = at('name');
        if (file && !name.value) name.value = file.name.replace(/\.png$/i, '');
        await paint();
    });
    at('material-tiling').addEventListener('change', paint);

    const show = (type) => {
        for (const [id, want] of [['form-model', type === 'model' || type === 'segment'],
            ['form-material', type === 'material'],
            ['form-profile', type === 'profile'],
            ['form-collection', type === 'collection']]) {
            at(id).hidden = !want;
        }
        // The GLB form's own Register button is enabled by a file being
        // picked; the other three are ready as soon as they are filled in.
        at('publish').disabled = (type === 'model' || type === 'segment')
            && !at('canon').textContent;
    };
    at('upload-type').addEventListener('change', () => show(at('upload-type').value));
    show('model');

    return {
        type: () => at('upload-type').value || 'model',
        show,
        material: () => material,
        profile: () => profile.value(),
        collection: () => collection.value(),
        publish: (type, meta) => publishTyped(type,
            { material, profile: () => profile.value(),
                collection: () => collection.value() }, meta, say),
    };
}

// --------------------------------------------------------------------- mount

// What a product may be and how it may be licensed are the `product` kind's
// properties, so an admin decides them (db/0040_properties.sql). The constants
// are only what a world whose admin has not said otherwise falls back to.
function fillChoices(doc, choices) {
    const categories = choices?.categories ?? CATEGORIES;
    const licences = choices?.licences ?? LICENSES;
    options(doc.getElementById('category'), categories, 'any');
    options(doc.getElementById('license'), licences, 'any');
    options(doc.getElementById('upload-category'), categories);
    options(doc.getElementById('upload-license'), licences);
}

export function mountCatalog(doc, { mountAuth, choices } = {}) {
    const results = doc.getElementById('results');
    const status = doc.getElementById('status');
    const detail = doc.getElementById('detail');
    fillChoices(doc, choices);
    fillTypes(doc);

    const held = new Set();
    const open = async (san) => {
        const asset = await getAsset(san);
        detail.hidden = !asset;
        if (!asset) return;
        detail.innerHTML = '';
        detail.append(el('h2', { textContent: asset.name }), detailOf(asset),
            el('p', {}, buyButton(asset, held, status, open), ' ',
                el('a', { href: glbUrl(asset), textContent: 'canonical glb' })));
    };

    const refresh = async () => {
        // Uploading needs an account; the panel follows the session whether it
        // was opened by the form or by a test signing in through api.js.
        doc.getElementById('upload').hidden = !api.claims();
        status.textContent = 'loading…';
        held.clear();
        for (const r of await myRights()) held.add(r.san);
        try {
            const rows = await searchAssets({
                search: doc.getElementById('q').value,
                category: doc.getElementById('category').value,
                license: doc.getElementById('license').value,
                type: doc.getElementById('type').value,
            });
            results.replaceChildren(...rows.length
                ? rows.map((asset) => card(asset, open)) : [nothingFound()]);
            status.textContent = rows.length ? `${rows.length} assets` : '';
        } catch (err) {
            status.textContent = String(err.message ?? err);
            status.className = 'muted bad';
        }
    };

    const say = (msg, bad = false) => {
        const node = doc.getElementById('upload-status');
        node.textContent = msg;
        node.className = bad ? 'muted bad' : 'muted';
    };
    const upload = new Upload(doc, say);
    const forms = typeForms(doc, say);
    wire(doc, { mountAuth, refresh, open, upload, forms });
    refresh();
    return { refresh, open, upload, forms };
}

// Every control on the panel, once. Register is the only one that has to know
// which of the five is being made: a model and a repeating piece are a GLB the
// tab canonicalised, the other three are made in their own form.
function wire(doc, { mountAuth, refresh, open, upload, forms }) {
    // On its own page the catalog carried the sign-in box; as a tab of the
    // world the Setup panel has it, and this only follows what it does.
    if (mountAuth) mountAuth(doc.getElementById('auth'), { onChange: refresh });
    doc.getElementById('refresh').addEventListener('click', refresh);
    for (const id of ['q', 'category', 'license', 'type']) {
        doc.getElementById(id).addEventListener('change', refresh);
    }
    doc.getElementById('file').addEventListener('change',
        (e) => upload.pick(e.target.files[0]));
    doc.getElementById('publish').addEventListener('click', async () => {
        const type = forms.type();
        const san = type === 'model' || type === 'segment'
            ? await upload.publish()
            : await forms.publish(type, upload.meta());
        // Each path says what it did — a repeating piece says how long its
        // repeat is — so nothing here overwrites it.
        if (san) {
            await refresh();
            await open(san);
        }
    });
}
