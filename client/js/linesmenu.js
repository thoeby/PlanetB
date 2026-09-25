// linesmenu.js — the menu a right click on a node opens (EDT.15): Split here,
// Join, Extend, Reverse. The deeds are client/js/lineedit.js NODE_DEEDS.

import { NODE_DEEDS } from './lineedit.js';
import { el } from './tabbar.js';

const ITEMS = [['split', 'Split here'], ['join', 'Join with the line that meets it'],
    ['extend', 'Extend from this end'], ['reverse', 'Reverse']];

export function mountNodeMenu(host, { state, done }) {
    const node = el('div', { id: 'ln-menu', className: 'glass', hidden: true });
    host.append(node);
    const hide = () => { node.hidden = true; };
    window.addEventListener('pointerdown', (e) => {
        if (!node.hidden && !node.contains(e.target)) hide();
    }, true);
    return {
        node, hide,
        open(line, i, x, y) {
            node.replaceChildren(...ITEMS.map(([id, words]) => {
                const b = el('button', { type: 'button', className: `ln-menu-${id}`,
                    textContent: words });
                b.onclick = () => {
                    hide();
                    done(id, NODE_DEEDS[id](state, line, i));
                };
                return b;
            }));
            node.style.left = `${x + 8}px`;
            node.style.top = `${y + 8}px`;
            node.hidden = false;
        },
    };
}
