// catalogdetail.js — what a product says about itself, as rows (the Shop's
// Details, UI.4). Split out of catalogui.js when the catalog became the
// Marketplace.

import { policyWords, typeWords } from './catalog.js';
import { fmtBytes } from './catalogupload.js';
import { canonMarks, isMarked, portWords, roleWords } from '../lib/marks.js';
import { profileWidth, repeatsEvery, stripsOf } from '../lib/product.js';

const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

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
    // FND.6: what is alive about this model, and what it can be told.
    if (isMarked(asset.parts)) {
        const m = canonMarks(asset.parts);
        return [['parts', m.parts.map((p) => `${p.name} \u2014 ${roleWords(p.role)}`)
            .join(', ') || 'none'],
        ['ports', portWords(m) || 'none'],
        ...(m.openings.length
            ? [['opens the ground', m.openings.map((o) => o.name).join(', ')]] : [])];
    }
    return [];
}

export function detailOf(asset) {
    const rows = [
        ['catalog number', asset.san],
        ['what it is', typeWords(asset.type)],
        ...typeRows(asset),
        ['category', asset.category],
        ['licence', asset.license === 'limited'
            ? `limited, ${asset.issued}/${asset.editions} issued` : asset.license],
        ['price', String(asset.price)],
        ['if you buy it', policyWords(asset)],
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

