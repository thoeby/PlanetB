// jobdetail.js — one job opened (design 8f): where the tile is, what its
// pieces are, what has happened to it, and what it pays.
//
// It reads the pool row it was handed (db/0146 pool_row, which carries the
// tile's last events) and the job's atoms, which are public (db/0003_rls). It
// writes nothing except through the same RPCs the cards use — claim_for,
// retry_job, drop_job, redo_renders — and setBounty.

import { tileBbox, tileCenter } from '../lib/tilemath.js';
import { hillshade, tileBox } from './hudmap.js';
import { cr, el, far } from './poolui.js';
import { setBounty } from './wallet.js';
import { jobButtons, logRows, pieces, shotCanvas, statusOf, stepLine } from './poolcard.js';
import { shotWords } from './workshots.js';

const M_PER_DEG = 111320;

// Where the tile is, on the same hillshade the corner map draws (hudmap.js):
// the ground this job is about, the tile's own footprint on it, and you. Not
// a slippy map — the one question it answers is "where is this, from here",
// which is a rectangle, an arrow and a distance. A grid with a box on it was
// a picture of nothing in particular, which is why this reads the ground.
export function drawWhere(canvas, { z, x, y }, { at = null, ground = null } = {}) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return 0;
    const b = tileBbox(z, x, y);
    const c = tileCenter(z, x, y);
    const cos = Math.cos((c.lat * Math.PI) / 180) || 1;
    const wide = (b.east - b.west) * M_PER_DEG * cos;
    const away = at ? Math.hypot((at.lon - c.lon) * M_PER_DEG * cos,
        (at.lat - c.lat) * M_PER_DEG) : 0;
    // Far enough away and the tile would be a pixel: the map holds the tile
    // and says how far you are, rather than drawing both to scale.
    const span = Math.max(wide * 3, Math.min(away * 2.4, wide * 14), 200);
    const { width: w, height: h } = canvas;
    // One metres-per-pixel, both ways. It was w/span across and h/span up, so
    // a square tile on a 380 by 220 canvas was drawn 380 by 220: the map said
    // a z14 tile is half again as wide as it is deep, which it is not.
    const scale = w / span;
    const px = (lon, lat) => [w / 2 + (lon - c.lon) * M_PER_DEG * cos * scale,
        h / 2 - (lat - c.lat) * M_PER_DEG * scale];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12151a';
    ctx.fillRect(0, 0, w, h);
    hillshade(ctx, { w, h, at: c, span, cos, ground });
    tileBox(ctx, b, px, { word: `${z}/${x}/${y}`, w, h });
    if (at) marker(ctx, px(at.lon, at.lat), w, h);
    return Math.round(span);
}

// You, kept inside the map: a player standing off the edge of it is drawn on
// the edge, because "which way is it" is worth more than the true position of
// a dot that is not on the canvas at all.
function marker(ctx, [ax, ay], w, h) {
    const mx = Math.min(Math.max(ax, 6), w - 6);
    const my = Math.min(Math.max(ay, 6), h - 6);
    ctx.fillStyle = '#f2efe8';
    ctx.strokeStyle = '#0b0d10';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx, my - 5); ctx.lineTo(mx + 5, my);
    ctx.lineTo(mx, my + 5); ctx.lineTo(mx - 5, my);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

const when = (t) => (t ? new Date(t).toLocaleTimeString() : '—');

const STATE_TONE = { verified: 'accent', submitted: 'accent', claimed: 'warn',
    ready: '', waiting: 'dim', failed: 'bad' };

// Every piece of the job, in the order the compiler will take them: what it is,
// when it last moved, and where it has got to.
function pieceRows(atoms) {
    return atoms.map((a) => el('div', { className: 'jd-piece' },
        el('i', { className: 'dot', 'data-tone': STATE_TONE[a.state] ?? '' }),
        el('span', { textContent: a.op }),
        el('span', { className: 'mono', textContent: when(a.claimed_at) }),
        el('span', { className: 'jd-state', 'data-tone': STATE_TONE[a.state] ?? '',
            textContent: a.state })));
}

// Where the tile is, in the numbers a person can act on: the two that fly you
// there, how far that is, and what the world thinks it is compiled to.
function placeRows(e, span) {
    const c = tileCenter(e.z, e.x, e.y);
    return [['Map', `${span} m across`],
        ['Centre', `${c.lat.toFixed(4)}N ${c.lon.toFixed(4)}E`],
        ['From you', far(e.metres) || 'unknown'],
        ['Version', `${e.version} · what this job compiles`],
        ['Beside it', `${e.siblings_published ?? 0} of ${e.siblings ?? 0} published`],
        ['Payout pool', Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free · nobody pays'],
    ].map(([k, v]) => el('div', { className: 'jd-fact' },
        el('span', { textContent: k }), el('span', { className: 'mono', textContent: v })));
}

// What to pay for this tile. It was on the wallet panel, where nothing ever
// told it which tile was meant; a price is a thing you put on a job, so it
// lives on the job.
function priceCard(e, { say, refresh }) {
    const amount = el('input', { type: 'number', min: '0', step: '1', value: '10',
        className: 'po-amount' });
    const set = el('button', { type: 'button', className: 'po-set primary',
        textContent: 'Raise the price' });
    set.onclick = async () => {
        set.disabled = true;
        try {
            await setBounty(e.job, Number(amount.value));
            say('held until the tile publishes');
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        set.disabled = false;
        await refresh();
    };
    return el('div', { className: 'jd-card' },
        el('div', { className: 'wk-card-head' },
            el('span', { className: 'label', textContent: 'What to pay for it' })),
        el('div', { className: 'jd-price' }, amount, set),
        el('p', { className: 'note',
            textContent: `It pays ${cr(e.bounty)} cr now. What you add is held from`
                + ' your credits until the tile publishes, and is then shared out'
                + ' by the time each tab reported.' }));
}

// The list down the left: every job in the queue this was opened from, so
// moving between them does not mean going back to the cards first.
function sideList(rows, current, open) {
    const list = el('div', { className: 'jd-list' });
    for (const r of rows) {
        const b = el('button', { type: 'button', className: 'jd-row' },
            el('span', { className: 'name', textContent: `${r.z}/${r.x}/${r.y}` }),
            el('span', { className: 'mono',
                textContent: [far(r.metres), r.made].filter(Boolean).join(' · ') }),
            el('span', { className: 'mono jd-pay',
                textContent: Number(r.bounty) > 0 ? cr(r.bounty) : 'free' }));
        b.setAttribute('aria-current', String(r.job === current));
        b.onclick = () => open(r);
        list.append(b);
    }
    return list;
}

function header(e, { acts, caps, onGo, close, doing }) {
    const go = el('button', { type: 'button', className: 'jd-go',
        textContent: 'Fly there' });
    go.onclick = () => onGo?.(tileCenter(e.z, e.x, e.y));
    const shut = el('button', { type: 'button', className: 'jd-close',
        textContent: '×', title: 'back to the cards' });
    shut.onclick = close;
    return el('div', { className: 'jd-head' },
        el('div', { className: 'jd-head-row' },
            el('span', { className: 'name', textContent: `${e.z}/${e.x}/${e.y}` }),
            el('span', { className: 'jd-status', textContent: statusOf(e, doing) }),
            el('div', { className: 'jd-acts' }, ...jobButtons(e, acts, caps, doing), go, shut)),
        // The chain, where the job is opened as well as on its card: this is
        // the thing four people may work on one after another (db/0153).
        stepLine(e));
}

// One job, whole. `rows` is the page of the queue it was opened from, and
// `atoms` its pieces, read once for the job that is open.
// What this tab has seen of the tile: the frames it traced and the splats it
// has fitted so far, side by side. Two different things — what the tile should
// look like, and what has been made of it — and the card can only show one.
function looks(shots) {
    const both = [['The frames it was drawn from', shots?.frame],
        ['The splats, as they are fitted', shots?.splat]]
        .map(([words, rec]) => [words, rec, shotCanvas(rec)])
        .filter(([, , canvas]) => canvas);
    if (!both.length) return null;
    return el('div', { className: 'jd-card jd-looks' },
        el('div', { className: 'wk-card-head' },
            el('span', { className: 'label', textContent: 'What it looks like' }),
            el('span', { className: 'note',
                textContent: 'from this tab\u2019s own work on it' })),
        el('div', { className: 'jd-shots' },
            ...both.map(([words, rec, canvas]) => el('figure', { className: 'jd-shot' },
                canvas,
                el('figcaption', {},
                    el('b', { textContent: words }),
                    el('span', { className: 'mono', textContent: shotWords(rec) }))))));
}

export function jobDetail(e, { rows, atoms, acts, caps, onGo, close, where,
    ground = null, shots = null, say, refresh, doing = '' }) {
    const canvas = el('canvas', { className: 'jd-map', width: 380, height: 220 });
    const node = el('div', { className: 'jd' },
        sideList(rows, e.job, acts.open),
        el('div', { className: 'jd-main' },
            header(e, { acts, caps, onGo, close, doing }),
            el('div', { className: 'jd-grid' },
                el('div', { className: 'jd-card' },
                    el('div', { className: 'wk-card-head' },
                        el('span', { className: 'label', textContent: 'Where it is' })),
                    canvas, el('div', { className: 'jd-facts' })),
                looks(shots),
                el('div', { className: 'jd-card' },
                    el('div', { className: 'wk-card-head' },
                        el('span', { className: 'label',
                            textContent: `Pieces · ${atoms.length}` }),
                        el('span', { className: 'mono', textContent: pieces(e) })),
                    el('div', { className: 'jd-pieces' }, ...pieceRows(atoms))),
                priceCard(e, { say, refresh }),
                el('div', { className: 'jd-card jd-logcard' },
                    el('div', { className: 'wk-card-head' },
                        el('span', { className: 'label',
                            textContent: 'What has happened to it' })),
                    ...(e.log?.length ? logRows(e, 6)
                        : [el('p', { className: 'note',
                            textContent: 'Nothing has happened to this tile yet.' })])))));
    const span = drawWhere(canvas, e, { at: where?.(), ground });
    node.querySelector('.jd-facts').replaceChildren(...placeRows(e, span));
    return node;
}
