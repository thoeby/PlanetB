// linespanel.js — what the Lines panel says about the selected line and does
// with it (EDT.17, EDT.18): Lay bed, Walk it, Reverse, Delete.
//
// Lay bed is the one place lines and ground meet (PLAN-editors D3): it opens
// Shape with Along line in hand and this line, its width, a shoulder and its
// kind's gradient filled in; Apply there lays the bed as one stroke.

import { el } from './tabbar.js';
import { NODE_DEEDS } from './lineedit.js';
import { curveOf } from './lines.js';
import { entryOf } from '../lib/kinds.js';
import { walkIt } from './linesdo.js';

export function mountSelected(host, ctx, state, say) {
    const title = el('div', { className: 'label ln-sel-title' });
    const act = (cls, words, fn) => {
        const b = el('button', { type: 'button', className: cls, textContent: words });
        b.onclick = fn;
        return b;
    };
    const node = el('div', { className: 'section ln-selected', hidden: true }, title,
        el('div', { className: 'sc-seg ln-deeds' },
            act('ln-bed primary', 'Lay bed', () => layBed(ctx, state, say)),
            act('ln-walk', 'Walk it · F', () => walkIt(ctx, state, say)),
            act('ln-reverse', 'Reverse', () => {
                if (state.selected) say(NODE_DEEDS.reverse(state, state.selected));
            }),
            act('ln-delete', 'Delete', () => {
                if (!state.selected) return;
                state.lines.remove(state.selected);
                state.selected = null;
                say('the line is gone — Save to keep it that way');
            })));
    host.append(node);
    return {
        draw() {
            node.hidden = !state.selected;
            if (state.selected) {
                const e = entryOf(state.entries, state.selected.kind, state.selected.props);
                title.textContent = e?.words ?? state.selected.kind;
            }
        },
    };
}

export function layBed(ctx, state, say) {
    const line = state.selected;
    if (!line) { say('select a line to lay its bed', true); return null; }
    const entry = entryOf(state.entries, line.kind, line.props);
    say('opening Shape with its bed');
    return ctx.layBed?.({ points: curveOf(line), width: Number(line.props?.width) || entry?.width,
        gradient: Math.min(30, entry?.gradient ?? 8), name: entry?.words ?? line.kind });
}
