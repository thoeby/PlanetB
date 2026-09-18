// poolcard.js — one job as a card, and the two rows of controls above the
// cards: which kind of work, and which page of it.
//
// The pool was a list of sixty identical lines with no way to see the
// sixty-first, and what had gone wrong on a tile lived in a panel that kept
// the last few messages and dropped them. A card says what the tile is
// waiting for, how far through it is, and the last few things that happened
// to it (db/0143 tile_event, carried on the row by db/0146 pool_row).

import { beyond, cr, el, what } from './poolui.js';

const KM = (m) => (m == null ? '' : (m < 950 ? `${Math.round(m)} m`
    : `${(m / 1000).toFixed(1)} km`));

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

// The pieces of a job, as a line of counts. Zeroes are left out: a card that
// says "0 failed" on every tile teaches nobody to look at the one that says 1.
function pieces(e) {
    const bits = [];
    if (Number(e.frames)) bits.push(`${e.frames_done}/${e.frames} frames`);
    if (Number(e.ready)) bits.push(`${e.ready} ready`);
    if (Number(e.claimed)) bits.push(`${e.claimed} in hand`);
    if (Number(e.blocked)) bits.push(`${e.blocked} waiting`);
    if (Number(e.failed)) bits.push(`${e.failed} failed`);
    if (Number(e.handed_back)) bits.push(`handed back ${e.handed_back}×`);
    return bits.join(' · ');
}

// The last few things that happened to this tile, newest first. This is the
// whole reason the card exists: "error 7 assemble — no ground at 14/8541/5795"
// used to be one line in a panel nobody was watching.
function log(e) {
    const rows = Array.isArray(e.log) ? e.log : [];
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
function preview(rec) {
    if (!rec?.picture?.rgba) return null;
    const p = rec.picture;
    const canvas = el('canvas', { className: 'po-shot', width: p.width, height: p.height });
    canvas.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    return el('figure', { className: 'po-shot-box' }, canvas,
        el('figcaption', { className: 'sub',
            textContent: `${p.width}\u00d7${p.height} \u00b7 ${rec.event === 'trained'
                ? 'as it finished' : `at step ${rec.iter ?? '?'}`}` }));
}

export function poolCard(e, acts, caps, shot = null) {
    const end = el('div', { className: 'end' },
        el('span', { style: `color: var(--${Number(e.bounty) > 0 ? 'warn' : 'ink-3'})`,
            textContent: Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free' }));
    const button = (text, cls, fn) => {
        const b = el('button', { type: 'button', className: cls, textContent: text });
        b.onclick = () => fn(e, b);
        return b;
    };
    if (Number(e.ready) && !beyond(e, caps)) {
        end.append(button('Render', 'po-render primary', acts.render));
    } else if (beyond(e, caps)) {
        end.append(el('span', { className: 'chip', 'data-tone': 'warn',
            textContent: 'not this machine' }));
    }
    // Only where there is training to redo: the frames are what it was
    // trained on, and asking for them again is how a tile that was trained
    // against the wrong ones is put right (db/0147).
    if (e.phase === 'train' && e.may_retry) {
        end.append(button('Redo the renders', 'po-retry', acts.redo));
    }
    if (Number(e.failed) > 0 && e.may_retry) {
        end.append(button('Try again', 'po-retry', acts.retry));
    }
    if (e.may_retry) end.append(button('Drop', 'po-retry', acts.drop));

    // Top to bottom: what it looks like, then what can be done to it, then
    // what has happened to it.
    const shown = preview(shot);
    return el('li', { className: 'po-card', 'data-phase': e.phase },
        el('div', { className: 'who' },
            ...(shown ? [shown] : []),
            el('div', { className: 'name', textContent: `${e.z}/${e.x}/${e.y}` }),
            el('div', { className: 'sub',
                textContent: [KM(e.metres), what(e), e.made,
                    e.phase === 'train' ? 'waiting to be trained'
                        : 'waiting to be drawn'].filter(Boolean).join(' · ') }),
            el('div', { className: 'sub', textContent: pieces(e) }),
            ...log(e)),
        end);
}

// Render jobs or training jobs, with how many of each there are.
export function phaseTabs(page, phase, pick) {
    return el('div', { className: 'row po-tabs' },
        ...[['render', 'Render jobs'], ['train', 'Training jobs']].map(([key, text]) => {
            const b = el('button', { type: 'button',
                textContent: `${text} (${Number(page?.[key] ?? 0)})` });
            if (key === phase) b.dataset.on = '1';
            b.onclick = () => pick(key);
            return b;
        }));
}

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
