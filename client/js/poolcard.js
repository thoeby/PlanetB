// poolcard.js — one job as a card (design 8a–8d), and the two control rows
// above the cards: what is shown, in what order, and which page of it.
//
// The pool was a list of sixty identical lines with no way to see the
// sixty-first, and what had gone wrong on a tile lived in a panel that kept
// the last few messages and dropped them. A card says what the tile is, what
// it is waiting for, how far through it is, and the last few things that
// happened to it (db/0143 tile_event, carried on the row by db/0146 pool_row).

import { drawWhere } from './hudmap.js';
import { beyond, cr, el, far, needs, stuck, what } from './poolui.js';
import { newest, shotWords } from './workshots.js';

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
    // One dataset per tile since db/0183: the line says whether it is drawn.
    if (Number(e.frames) === 1) bits.push(Number(e.frames_done) ? 'dataset drawn' : 'dataset to draw');
    else if (Number(e.frames)) bits.push(`${e.frames_done}/${e.frames} frames`);
    if (Number(e.ready)) bits.push(`${e.ready} ready`);
    if (Number(e.claimed)) bits.push(`${e.claimed} in hand`);
    if (Number(e.blocked)) bits.push(`${e.blocked} waiting`);
    if (Number(e.failed)) bits.push(`${e.failed} failed`);
    if (Number(e.handed_back)) bits.push(`handed back ${e.handed_back}×`);
    return bits.join(' · ');
}

// The steps a job is made of, and how far each has got (db/0153 job_steps).
// A compile is four things in a row that four different people may do, and
// the card said none of that: it had a button and a count of pieces.
const STEP_WORD = { dataset: 'dataset', assemble: 'ground', frame: 'frames', train: 'training',
    sog: 'packing', merge: 'merge', verify: 'checks' };

export function stepsOf(e) {
    const steps = Array.isArray(e.steps) ? e.steps : [];
    return steps.map((s) => ({
        word: STEP_WORD[s.op] ?? s.op,
        count: Number(s.total) > 1 ? `${s.done}/${s.total}` : '',
        state: s.state,
    }));
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

// One picture, as a canvas: a traced frame arrives as webp bytes and the
// splats as rgba the tab drew itself. Exported because the card shows the
// newer of the two and the opened card shows both (client/js/jobdetail.js).
export function shotCanvas(rec) {
    const p = rec?.picture;
    if (!p?.rgba && !p?.webp) return null;
    const canvas = el('canvas', { className: 'po-shot',
        width: p.width ?? 256, height: p.height ?? 256 });
    if (p.rgba) {
        canvas.getContext('2d').putImageData(
            new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    } else {
        paint(canvas, p.webp);
    }
    return canvas;
}

// The last picture this tab drew of the tile, if it drew one, and what it is
// of — "frame 2 of 3", "step 400 of 2400 · 134 000 splats". It used to say
// "256×256", which is the size of the thumbnail and reads as a claim about how
// the world is being rendered.
//
// A tile nobody here has worked on has no picture, and says so rather than
// leaving a grey box with no explanation.
function shot(e, shots, live, place) {
    const box = el('div', { className: 'jc-shot' },
        el('span', { className: 'jc-kind', textContent: KIND[e.phase] ?? e.phase }),
        el('span', { className: 'jc-pay', 'data-paid': Number(e.bounty) > 0 ? '1' : '',
            textContent: Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free' }),
        el('span', { className: 'jc-over mono', textContent: e.made }));
    const rec = newest(shots);
    const canvas = shotCanvas(rec);
    if (!canvas) {
        const map = whereCanvas(e, place);
        if (map) box.append(map);
        box.append(el('span', { className: `jc-thumb mono${map ? ' jc-shotline' : ''}`,
            textContent: live ? 'working on it now' : 'nothing drawn here yet' }));
        return box;
    }
    box.append(canvas, el('span', { className: 'jc-thumb jc-shotline mono',
        textContent: shotWords(rec) }));
    // Where both exist, the card says so: the frames are what the tile should
    // look like and the splats are what has been made of them so far, and the
    // opened card puts the two side by side.
    if (shots?.frame && shots?.splat) {
        box.append(el('span', { className: 'jc-thumb jc-both mono',
            textContent: 'frames and splats \u00b7 details' }));
    }
    return box;
}

// How big the card draws its own map. Wider than tall, because that is the
// shape of the space the picture would have filled, and drawWhere measures
// both ways off the width.
const MAP = { width: 320, height: 180 };

// A card with nothing drawn on its tile yet: the ground it is about, rather
// than a hatch and the words "nothing drawn here yet". A tile that has never
// been rendered is most of the pool, so most of the cards were four words on a
// grey box — and where the tile is is the one thing knowable before anybody
// has drawn it.
function whereCanvas(e, place) {
    if (!place) return null;
    const canvas = el('canvas', { className: 'po-shot jc-where', ...MAP });
    drawWhere(canvas, e, place);
    return canvas;
}

// A traced frame arrives as webp bytes: drawn when the decode lands, and a
// click opens the one that is showing at full size. A frame is on screen for
// as long as the next one takes to draw, which is milliseconds, and nobody can
// judge a picture from that.
function paint(canvas, webp) {
    const blob = new Blob([webp], { type: 'image/webp' });
    canvas.title = 'click for the full-size frame';
    canvas.onclick = (event) => {
        event.stopPropagation();
        globalThis.open?.(URL.createObjectURL(blob), '_blank');
    };
    createImageBitmap(blob).then((bitmap) => {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
    }).catch(() => {});
}

// What may be done to a job: Render only where there is something a tab could
// be handed, and the three that put one right only where the ground is yours.
// The card and the opened card offer the same, in the same words.
// What the button that takes the work says. "Render" was on all three: a
// training job takes a quarter of an hour of GPU and said the same word as a
// pack that takes two seconds. `doing` is the same button while this tab is
// on that job — a job cannot be taken twice, and a button that looks pressable
// while its work is running is a button somebody presses again.
const TAKE = { render: 'Render', train: 'Train', publish: 'Pack' };
const TAKING = { render: 'Rendering…', train: 'Training…', publish: 'Packing…' };

export function jobButtons(e, acts, caps, doing = '') {
    const out = [];
    const button = (text, cls, fn) => {
        const b = el('button', { type: 'button', className: cls, textContent: text });
        b.onclick = () => fn(e, b);
        return b;
    };
    if (doing) {
        const b = button(TAKING[e.phase] ?? 'Working…', 'po-render primary', () => {});
        b.disabled = true;
        out.push(b);
    } else if (Number(e.ready) && !beyond(e, caps)) {
        out.push(button(TAKE[e.phase] ?? 'Render', 'po-render primary', acts.render));
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

function actions(e, acts, caps, doing) {
    const open = el('button', { type: 'button', className: 'jc-open',
        textContent: 'Details \u203a' });
    open.onclick = () => acts.open?.(e);
    return el('div', { className: 'jc-foot' }, ...jobButtons(e, acts, caps, doing), open);
}

// The chain, as one line: ground · frames 2/3 · training · packing, with the
// step it has got to lit and the ones behind it done. Anybody may take any of
// them that is ready — the steps do not belong to whoever started the tile.
export function stepLine(e) {
    const steps = stepsOf(e);
    if (!steps.length) return el('div', { className: 'jc-steps' });
    return el('div', { className: 'jc-steps' }, ...steps.map((s) => {
        const node = el('span', { className: 'jc-step' },
            el('b', { textContent: s.word }),
            s.count ? el('i', { className: 'mono', textContent: s.count }) : null);
        node.dataset.state = s.state;
        return node;
    }));
}

export function poolCard(e, acts, caps, shots = null, doing = '', place = null) {
    const bar = share(e);
    const li = el('li', { className: 'po-card', 'data-phase': e.phase },
        shot(e, shots, Boolean(doing), place),
        el('div', { className: 'jc-body' },
            el('div', { className: 'jc-title' },
                el('span', { className: 'name', textContent: `${e.z}/${e.x}/${e.y}` }),
                el('span', { className: 'mono jc-dist', textContent: far(e.metres) })),
            el('span', { className: 'jc-status', textContent: statusOf(e, doing) }),
            el('span', { className: 'sub', textContent: what(e) }),
            el('span', { className: 'sub mono', textContent: needs(e, caps) }),
            ...(bar === null ? [] : [el('div', { className: 'jc-bar' },
                el('i', { style: `width: ${bar}%` }))]),
            stepLine(e),
            el('span', { className: 'mono jc-count', textContent: pieces(e) })),
        actions(e, acts, caps, doing),
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
