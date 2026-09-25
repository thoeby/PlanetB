// bploading.js — the screen between pressing Shape or Lines and the clay
// being there (the operator's note): the land is read, its elevation fetched
// and the clay built, which on a large land is seconds, and until now it was
// seconds of the old world standing still with nothing said.

import { el } from './tabbar.js';

// `bp` says, through it, which step of opening the clay it is at.
export function mountLoading(host, bp = null) {
    const words = el('p', { className: 'bp-loading-words' });
    const node = el('div', { id: 'bp-loading', hidden: true },
        el('div', { className: 'bp-loading-card glass' },
            el('span', { className: 'bp-loading-spin' }), words));
    host.append(node);
    if (bp) bp.onStep = (text) => { if (depth) words.textContent = text; };
    // Shape asks while Lines' own asking is still going, and the screen goes
    // only when both are done.
    let depth = 0;
    return {
        node,
        begin(text) {
            depth += 1;
            words.textContent = text;
            node.hidden = false;
        },
        step(text) { if (depth) words.textContent = text; },
        end() {
            depth = Math.max(0, depth - 1);
            if (!depth) node.hidden = true;
        },
    };
}

// Whatever `work` is, with the screen up while it runs.
export async function whileLoading(loading, text, work) {
    loading.begin(text);
    try {
        return await work();
    } finally {
        loading.end();
    }
}
