// catalogupload.js — the GLB half of Register: canonicalise the file the maker
// picked, show what came out, mark its live parts, and publish it.
//
// Split out of catalogui.js for size (CLAUDE.md). The four products that are
// not a GLB are catalogtypes.js; what a marking may be is client/lib/marks.js
// and, where it counts, db/0160 (Invariant 6).

import * as api from './api.js';
import { duplicatesOf, getAsset, prepare, publishAsset } from './catalog.js';
import { ModelPreview } from './modelpreview.js';
import { el } from './poolui.js';
import { isMarked, marksTrouble, portWords } from '../lib/marks.js';
import { repeatsEvery, segmentTrouble } from '../lib/product.js';

export const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);

export class Upload {
    constructor(doc, say) {
        this.doc = doc;
        this.say = say;
        this.canon = null;
        this.bytes = null;
        this.file = null;
        this.marks = null;
        // The thumbnail is drawn off-screen, exactly as an atom would draw it,
        // and the visible preview is painted from the WebP that comes out — so
        // what the uploader sees is the file the catalog will serve. A model
        // with live parts is drawn again instead (FND.6), because what its
        // ports do is not in one picture.
        this.canvas = (w, h) => new OffscreenCanvas(w, h);
        this.model = new ModelPreview(this.canvas);
    }

    // The canon runs before anything leaves the tab, so the uploader sees the
    // number and the near-duplicates before they commit to either.
    async pick(file) {
        this.canon = null;
        this.file = file ?? null;
        this.marks = null;
        this.doc.getElementById('publish').disabled = true;
        if (!file) return;
        this.bytes = new Uint8Array(await file.arrayBuffer());
        await this.recanon();
        this.onFile?.(this.canon?.nodes ?? []);
    }

    // Again, with whatever is marked now: a marking changes which nodes stay
    // meshes of their own, so it changes the file and the number with it.
    async recanon(values = {}) {
        if (!this.bytes) return;
        this.say('canonicalising…');
        try {
            this.canon = await prepare(this.bytes,
                { canvas: this.canvas, marks: this.marks });
            this.show(this.file);
            await this.paint(values);
            await this.already();
            this.say('');
        } catch (err) {
            this.doc.getElementById('canon').textContent = '';
            this.say(String(err.message ?? err), true);
        }
    }

    // A product with this file and these markings may already be in the
    // catalog — registering it again would find it rather than make it.
    async already() {
        const host = this.doc.getElementById('already');
        if (!host) return;
        const found = this.canon?.san ? await getAsset(this.canon.san) : null;
        const who = found ? await api.rpc('player_name', { who: found.creator_id })
            .catch(() => null) : null;
        host.textContent = found
            ? `this is already ${found.name}${who ? ` by ${who}` : ''}` : '';
    }

    async paint(values = {}) {
        const preview = this.doc.getElementById('preview');
        if (!preview || !this.canon) return;
        if (isMarked(this.marks)) {
            this.model.draw(preview, this.canon.glb,
                { marks: this.marks, values, highlight: this.highlight });
            return;
        }
        if (!this.canon.thumb) return;
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
        // repeat is refused here and again by db/0159 (Invariant 6).
        if (meta.type === 'segment') {
            const trouble = segmentTrouble(this.canon.meta.bbox);
            if (trouble) { this.say(trouble, true); return null; }
        }
        const wrong = isMarked(this.marks)
            ? marksTrouble(this.marks, this.canon.nodes) : null;
        if (wrong) { this.say(wrong, true); return null; }
        this.near(await duplicatesOf(meta.name, this.canon));
        this.say('uploading…');
        try {
            const san = await publishAsset(this.canon, meta);
            const ports = portWords(this.marks);
            this.say(`published ${san}${meta.type === 'segment'
                ? ` \u00b7 ${repeatsEvery(this.canon.meta.bbox)}` : ''}`
                + (ports ? ` \u00b7 ports: ${ports}` : ''));
            return san;
        } catch (err) {
            this.say(String(err.message ?? err), true);
            return null;
        }
    }
}
