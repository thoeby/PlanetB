// catalogui.js — the DOM half of catalog.html. Plain DOM, no framework.
//
// It owns the page and nothing else: searching, uploading and registering are
// catalog.js, and what a signed-in user may do is decided by row-level security
// (Invariant 6).

import * as api from './api.js';
import { CATEGORIES, LICENSES, duplicatesOf, getAsset, glbUrl, prepare, publishAsset,
    searchAssets, thumbUrl } from './catalog.js';

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
            `${asset.category} · ${asset.license} · ${asset.tris} tris` })));
}

function detailOf(asset) {
    const rows = [
        ['catalog number', asset.san],
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
            price: Number(value('price')) || 0,
            editions: license === 'limited' ? Number(value('editions')) || 1 : null,
        };
    }

    async publish() {
        if (!this.canon) return null;
        const meta = this.meta();
        this.near(await duplicatesOf(meta.name, this.canon));
        this.say('uploading…');
        try {
            const san = await publishAsset(this.canon, meta);
            this.say(`published ${san}`);
            return san;
        } catch (err) {
            this.say(String(err.message ?? err), true);
            return null;
        }
    }
}

// --------------------------------------------------------------------- mount

export function mountCatalog(doc, { mountAuth }) {
    const results = doc.getElementById('results');
    const status = doc.getElementById('status');
    const detail = doc.getElementById('detail');
    options(doc.getElementById('category'), CATEGORIES, 'any');
    options(doc.getElementById('license'), LICENSES, 'any');
    options(doc.getElementById('upload-category'), CATEGORIES);
    options(doc.getElementById('upload-license'), LICENSES);

    const open = async (san) => {
        const asset = await getAsset(san);
        detail.hidden = !asset;
        if (!asset) return;
        detail.innerHTML = '';
        detail.append(el('h2', { textContent: asset.name }), detailOf(asset),
            el('p', {}, el('a', { href: glbUrl(asset), textContent: 'canonical glb' })));
    };

    const refresh = async () => {
        // Uploading needs an account; the panel follows the session whether it
        // was opened by the form or by a test signing in through api.js.
        doc.getElementById('upload').hidden = !api.claims();
        status.textContent = 'loading…';
        try {
            const rows = await searchAssets({
                search: doc.getElementById('q').value,
                category: doc.getElementById('category').value,
                license: doc.getElementById('license').value,
            });
            results.innerHTML = '';
            for (const asset of rows) results.append(card(asset, open));
            status.textContent = rows.length ? `${rows.length} assets` : 'nothing here yet';
        } catch (err) {
            status.textContent = String(err.message ?? err);
            status.className = 'bad';
        }
    };

    const say = (msg, bad = false) => {
        const node = doc.getElementById('upload-status');
        node.textContent = msg;
        node.className = bad ? 'bad' : 'muted';
    };
    const upload = new Upload(doc, say);

    mountAuth(doc.getElementById('auth'), { onChange: refresh });
    doc.getElementById('refresh').addEventListener('click', refresh);
    doc.getElementById('q').addEventListener('change', refresh);
    doc.getElementById('category').addEventListener('change', refresh);
    doc.getElementById('license').addEventListener('change', refresh);
    doc.getElementById('file').addEventListener('change', (e) => upload.pick(e.target.files[0]));
    doc.getElementById('publish').addEventListener('click', async () => {
        const san = await upload.publish();
        if (san) { await refresh(); await open(san); }
    });
    refresh();
    return { refresh, open, upload };
}
