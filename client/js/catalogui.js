// catalogui.js — registering a product: the forms behind Marketplace ›
// Selling › Put a model on sale (TASKS-ui.md UI.5). Plain DOM, no framework.
//
// Uploading and registering are catalog.js; what a signed-in player may do is
// row-level security's (Invariant 6). Finding and buying are the Shop's
// (client/js/shop.js).

import { TYPES } from './catalog.js';
import { mountMarksForm } from './catalogmarks.js';
import { mountFileForm } from './catalogplugin.js';
import { Upload } from './catalogupload.js';
import { canonMarks, isMarked } from '../lib/marks.js';
import { mountCollectionForm, mountProfileForm, paintMaterial, publishTyped }
    from './catalogtypes.js';

const options = (select, values) => {
    select.replaceChildren(...values.map((v) => new Option(v, v)));
};

// ---------------------------------------------------------------- the forms

// Which of the five is being registered, and therefore which form is on
// screen and what Register does with it. A model and a repeating piece share
// the GLB form; the other three have one each.
function typeForms(doc, say) {
    const at = (id) => doc.getElementById(id);
    const material = { bytes: null, width: 0, height: 0, tiling: 4 };
    const profile = mountProfileForm(at('form-profile'));
    const collection = mountCollectionForm(at('form-collection'));
    const picked = mountFileForm(doc);

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
            ['form-collection', type === 'collection'],
            ['form-file', type === 'plugin' || type === 'flow']]) {
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
                collection: () => collection.value(), picked }, meta, say),
    };
}

// --------------------------------------------------------------------- mount

// What a product may be and how it may be licensed are the `product` kind's
// properties, so an admin decides them (db/0040_properties.sql).
function fillChoices(doc, choices) {
    options(doc.getElementById('upload-category'), choices?.categories ?? []);
    options(doc.getElementById('upload-license'), choices?.licences ?? []);
    doc.getElementById('upload-type')
        .replaceChildren(...TYPES.map((t) => new Option(t.words, t.id)));
}

export function mountRegister(doc, { choices, onPublished } = {}) {
    fillChoices(doc, choices);
    const say = (msg, bad = false) => {
        const node = doc.getElementById('upload-status');
        node.textContent = msg;
        node.className = bad ? 'status muted bad' : 'status muted';
    };
    const upload = new Upload(doc, say);
    const marks = mountMarks(doc, upload);
    const forms = typeForms(doc, say);
    wire(doc, { upload, forms, onPublished });
    return { upload, forms, marks };
}

// The Parts step (FND.6). A marking changes which nodes stay meshes of their
// own, so the file is made again whenever one changes; flipping a port only
// changes the picture, and the picture is all that is drawn again.
function mountMarks(doc, upload) {
    const EMPTY = JSON.stringify(canonMarks({}));
    let last = EMPTY;
    const form = mountMarksForm(doc.getElementById('form-parts'), {
        onChange: (value, at) => {
            upload.highlight = at && value.parts.find((p) => p.node === at)?.name;
            const now = JSON.stringify(value);
            upload.marks = isMarked(value) ? value : null;
            if (now !== last) { last = now; upload.recanon(form.values()); } else {
                upload.paint(form.values());
            }
        },
    });
    upload.onFile = (nodes) => { last = EMPTY; form.show(nodes); };
    return form;
}

// Every control of the register form, once. Register is the only one that has
// to know which of the five is being made: a model and a repeating piece are a
// GLB the tab canonicalised, the other three are made in their own form.
function wire(doc, { upload, forms, onPublished }) {
    doc.getElementById('file').addEventListener('change',
        (e) => upload.pick(e.target.files[0]));
    doc.getElementById('publish').addEventListener('click', async () => {
        const type = forms.type();
        const san = type === 'model' || type === 'segment'
            ? await upload.publish()
            : await forms.publish(type, upload.meta());
        // Each path says what it did — a repeating piece says how long its
        // repeat is — so nothing here overwrites it.
        if (san) await onPublished?.(san);
    });
}
