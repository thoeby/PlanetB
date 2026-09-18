// poolcard.js — one job as a card (design 8a–8d), and the two control rows
// above the cards: what is shown, in what order, and which page of it.
//
// The pool was a list of sixty identical lines with no way to see the
// sixty-first, and what had gone wrong on a tile lived in a panel that kept
// the last few messages and dropped them. A card says what the tile is, what
// it is waiting for, how far through it is, and the last few things that
// happened to it (db/0143 tile_event, carried on the row by db/0146 pool_row).

import { beyond, cr, el, far, needs, stuck, what } from './poolui.js';

const AGO = (at) => {
    const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    if (s < 90) return `${Math.round(s)}s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
};

// What the tile is waiting for, in the words of the atom that is next.
const TONE = { gave_up: 'bad', failed: 'bad', refused: 'bad',
    handed_back: 'warn', published: 'ok' };

// The three kinds of work the pool sorts into (db/0152 pool_open.phase), as
// the design names them on the card.
const KIND = { render: 'render', train: 'training', publish: 'packing' };

// The pieces of a job, as a line of counts. Zeroes are left out: a card that
// says "0 failed" on every tile teaches nobody to look at the one that says 1.
export function pieces(e) {
    const bits = [];
    if (Number(e.frames)) bits.push(`${e.frames_done}/${e.frames} frames`);
    if (Number(e.ready)) bits.push(`${e.ready} ready`);
    if (Number(e.claimed)) bits.push(`${e.claimed} in hand`);
    if (Number(e.blocked)) bits.push(`${e.blocked} waiting`);
    if (Number(e.failed)) bits.push(`${e.failed} failed`);
    if (Number(e.handed_back)) bits.push(`handed back ${e.handed_back}×`);
    return bits.join(' · ');
}

// How far through its frames a tile is. A job with no frames of its own — a
// merge, a pack — has no bar: a bar at nought that never moves says less than
// no bar at all.
export const share = (e) => (Number(e.frames)
    ? Math.round((Number(e.frames_done) / Number(e.frames)) * 100) : null);

// What the job is waiting for, in one sentence (design 8's status line).
export function statusOf(e, doing = '') {
    if (doing) return `${doing} on this machine`;
    // Nothing anybody's tab can be given: whatever is left is blocked behind
    // a piece that gave up, and a piece in somebody's hands is not that.
    if (stuck(e)) {
        return e.may_retry ? 'stopped · start it over or drop it'
            : 'stopped · its owner can try again';
    }
    return e.phase === 'train' ? `${e.made} · waiting to be trained`
        : `${e.made} · waiting to be drawn`;
}

// The last few things that happened to this tile, newest first. This is the
// whole reason the card carries a log: "error 7 assemble — no ground at
// 14/8541/5795" used to be one line in a panel nobody was watching.
export function logRows(e, limit = 3) {
    const rows = Array.isArray(e.log) ? e.log.slice(0, limit) : [];
    if (!rows.length) return [];
    return [el('ul', { className: 'po-log' }, ...rows.map((r) => el('li', {},
        el('span', { className: 'chip', 'data-tone': TONE[r.kind] ?? '',
            textContent: r.kind.replace('_', ' ') }),
        el('span', { className: 'po-log-what',
            textContent: `${r.op ? `${r.op}: ` : ''}${r.detail}` }),
        el('span', { className: 'po-log-when', textContent: AGO(r.at) }))))];
}

// The last picture this tab drew of the tile, if it drew one: a canvas the
// card owns, painted from the record the work loop kept (client/js/work.js
// pictures). A tile nobody here has worked on has none, and says so rather
// than leaving a grey box with no explanation.
function shot(e, rec, live) {
    const box = el('div', { className: 'jc-shot' },
        el('span', { className: 'jc-kind', textContent: KIND[e.phase] ?? e.phase }),
        el('span', { className: 'jc-pay', 'data-paid': Number(e.bounty) > 0 ? '1' : '',
            textContent: Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free' }),
        el('span', { className: 'jc-over mono', textContent: e.made }));
    const p = rec?.picture;
    if (!p?.rgba) {
        box.append(el('span', { className: 'jc-thumb mono',
            textContent: live ? 'working on it now' : 'nothing drawn here yet' }));
        return box;
    }
    const canvas = el('canvas', { className: 'po-shot', width: p.width, height: p.height });
    canvas.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    box.append(canvas, el('span', { className: 'jc-thumb jc-shotline mono',
        textContent: `${p.width}×${p.height} · ${rec.event === 'trained'
            ? 'as it finished' : `at step ${rec.iter ?? '?'}`}` }));
    return box;
}

// What may be done to a job: Render only where there is something a tab could
// be handed, and the three that put one right only where the ground is yours.
// The card and the opened card offer the same, in the same words.
export function jobButtons(e, acts, caps) {
    const out = [];
    const button = (text, cls, fn) => {
        const b = el('button', { type: 'button', className: cls, textContent: text });
        b.onclick = () => fn(e, b);
        return b;
    };
    if (Number(e.ready) && !beyond(e, caps)) {
        out.push(button('Render', 'po-render primary', acts.render));
    } else if (beyond(e, caps)) {
        out.push(el('span', { className: 'chip', 'data-tone': 'warn',
            textContent: 'not this machine' }));
    }
    // Only where there is training to redo: the frames are what it was
    // trained on, and asking for them again is how a tile that was trained
    // against the wrong ones is put right (db/0147).
    if (e.phase === 'train' && e.may_retry) {
        out.push(button('Redo the renders', 'po-retry', acts.redo));
    }
    if (Number(e.failed) > 0 && e.may_retry) {
        out.push(button('Try again', 'po-retry', acts.retry));
    }
    if (e.may_retry) out.push(button('Drop', 'po-retry', acts.drop));
    return out;
}

function actions(e, acts, caps) {
    const open = el('button', { type: 'button', className: 'jc-open',
        textContent: 'Details \u203a' });
    open.onclick = () => acts.open?.(e);
    return el('div', { className: 'jc-foot' }, ...jobButtons(e, acts, caps), open);
}

export function poolCard(e, acts, caps, rec = null, doing = '') {
    const bar = share(e);
    const li = el('li', { className: 'po-card', 'data-phase': e.phase },
        shot(e, rec, Boolean(doing)),
        el('div', { className: 'jc-body' },
            el('div', { className: 'jc-title' },
                el('span', { className: 'name', textContent: `${e.z}/${e.x}/${e.y}` }),
                el('span', { className: 'mono jc-dist', textContent: far(e.metres) })),
            el('span', { className: 'jc-status', textContent: statusOf(e, doing) }),
            el('span', { className: 'sub', textContent: what(e) }),
            el('span', { className: 'sub mono', textContent: needs(e, caps) }),
            ...(bar === null ? [] : [el('div', { className: 'jc-bar' },
                el('i', { style: `width: ${bar}%` }))]),
            el('span', { className: 'mono jc-count', textContent: pieces(e) })),
        actions(e, acts, caps),
        ...logRows(e));
    if (doing) li.dataset.live = '1';
    // The whole card opens it, not only the words that say so (design 8f).
    li.onclick = (event) => {
        if (event.target.closest('button')) return;
        acts.open?.(e);
    };
    return li;
}

// A row of chips where one of them is the choice (design 8's Show and Sort
// lines). They are buttons: this is a control, not a legend.
export function chipRow(label, items, on, pick) {
    const row = el('div', { className: 'jc-chips' },
        el('span', { className: 'label', textContent: label }));
    for (const [key, text, count] of items) {
        const b = el('button', { type: 'button', className: 'jc-chip',
            textContent: text });
        if (count !== null && count !== undefined) {
            b.append(el('i', { className: 'mono', textContent: String(count) }));
        }
        if (key === on) b.dataset.on = '1';
        b.onclick = () => pick(key);
        row.append(b);
    }
    return row;
}

// Whose work: everything in this queue, or the ground the player can put
// right themselves (db/0152 pool_open.mine). Only the All tab asks.
export const showChips = (page, phase, pick) => chipRow('Show',
    [['all', 'All', page?.all ?? 0], ['mine', 'Mine', page?.mine ?? 0]],
    phase === 'mine' ? 'mine' : 'all', pick);

// Nearest is what somebody is waiting to walk on; best pay is what a
// stranger's tab is looking for. Both have to cut the list, not just sort the
// page that was already cut the other way (db/0142, db/0152).
export const sortChips = (page, pick) => chipRow('Sort',
    [['near', 'Nearest'], ['pay', 'Best pay']], page?.sort ?? 'near', pick);

// Which page of them. Shown whenever there is more than one, because a panel
// that silently holds sixty of four hundred is the one this replaces.
export function pager(page, size, go) {
    const total = Number(page?.total ?? 0);
    const at = Number(page?.offset ?? 0);
    const pages = Math.max(1, Math.ceil(total / size));
    const now = Math.floor(at / size) + 1;
    const step = (to) => {
        const b = el('button', { type: 'button', textContent: to.text });
        b.disabled = to.off === null;
        b.onclick = () => go(to.off);
        return b;
    };
    return el('div', { className: 'row po-pager' },
        step({ text: '‹ back', off: at > 0 ? Math.max(0, at - size) : null }),
        el('span', { className: 'sub',
            textContent: total ? `page ${now} of ${pages} · ${total} tile(s)`
                : 'nothing waiting' }),
        step({ text: 'next ›', off: at + size < total ? at + size : null }));
}
