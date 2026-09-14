// notify.js — what happened while you were looking somewhere else.
//
// A notification lands under the bell for eight seconds and then stops being
// in the way; the bell keeps it, and the tray is the list of them. Nothing
// here knows what any of them mean: whoever has news calls push().
//
// Taken from docs/design/chrome6.dc.html.

import { el } from './tabbar.js';

export const TOAST_MS = 8000;
const KEEP = 20;

const TONE = { ok: 'ok', warn: 'warn', bad: 'bad' };

const stamp = (at) => at.toTimeString().slice(0, 5);

// How long ago, in the words a glance needs: seconds, then minutes, then the
// time it happened.
export function ago(then, now = Date.now()) {
    const s = Math.max(0, Math.round((now - then) / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return stamp(new Date(then));
}

function line(n) {
    const node = el('li', {},
        el('i', {}),
        el('div', { className: 'what' },
            el('span', { className: 'title', textContent: n.title }),
            el('span', { className: 'meta', textContent: n.meta ?? '' })),
        el('span', { className: 'when mono', textContent: stamp(new Date(n.at)) }));
    node.dataset.tone = n.tone;
    return node;
}

export function mountNotify() {
    const list = el('ul', {});
    const empty = el('p', { className: 'empty',
        textContent: 'Nothing yet. New ones show under the bell for eight seconds first.' });
    const tray = el('div', { id: 'tray', className: 'glass' },
        el('div', { className: 'head' },
            el('span', { className: 'caps', textContent: 'Notifications' }),
            el('button', { type: 'button', className: 'clear', textContent: 'Mark all read' })),
        list, empty);
    tray.hidden = true;
    const toasts = el('div', { id: 'toasts' });
    const kept = [];
    let onCount = null;

    const redraw = () => {
        list.replaceChildren(...kept.map(line));
        empty.hidden = kept.length > 0;
        onCount?.(kept.length);
    };
    tray.querySelector('.clear').onclick = () => { kept.length = 0; redraw(); };

    return {
        tray,
        toasts,
        count: () => kept.length,
        onCount(fn) { onCount = fn; },
        open(yes) { tray.hidden = !yes; },
        isOpen: () => !tray.hidden,
        // `tone` is ok, warn or bad; anything else is ok. Returns the toast so
        // a test can watch it go.
        push({ title, meta, tone = 'ok' } = {}) {
            const n = { title, meta, tone: TONE[tone] ?? 'ok', at: Date.now() };
            kept.unshift(n);
            kept.length = Math.min(kept.length, KEEP);
            redraw();
            const toast = el('div', { className: 'toast glass' },
                el('i', {}),
                el('span', { className: 'title', textContent: title }),
                el('span', { className: 'meta', textContent: meta ?? '' }),
                el('u', {}));
            toast.dataset.tone = n.tone;
            toasts.prepend(toast);
            setTimeout(() => toast.remove(), TOAST_MS);
            return toast;
        },
    };
}
