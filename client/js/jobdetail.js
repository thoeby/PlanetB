// jobdetail.js — one job opened (design 8f): where the tile is, what its
// pieces are, what has happened to it, and what it pays.
//
// It reads the pool row it was handed (db/0146 pool_row, which carries the
// tile's last events) and the job's atoms, which are public (db/0003_rls). It
// writes nothing except through the same RPCs the cards use — claim_for,
// retry_job, drop_job, redo_renders — and setBounty.

import { tileBbox, tileCenter } from '../lib/tilemath.js';
import { cr, el, far } from './poolui.js';
import { setBounty } from './wallet.js';
import { jobButtons, logRows, pieces, statusOf } from './poolcard.js';

const M_PER_DEG = 111320;

// The tile on a square of ground, and you on it. Not a slippy map: the one
// thing this answers is "where is this, from here", which is a rectangle and
// an arrow (design 8f's Map · 2 km).
export function drawWhere(canvas, { z, x, y }, at) {
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
    const px = (lon, lat) => [w / 2 + ((lon - c.lon) * M_PER_DEG * cos * w) / span,
        h / 2 - ((lat - c.lat) * M_PER_DEG * h) / span];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12151a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= w; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke();
    }
    const [x0, y0] = px(b.west, b.north);
    const [x1, y1] = px(b.east, b.south);
    // Canvas does not read CSS variables: the accent, written out.
    ctx.fillStyle = 'rgba(106, 209, 231, 0.22)';
    ctx.strokeStyle = 'rgba(106, 209, 231, 0.9)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (at) {
        const [ax, ay] = px(at.lon, at.lat);
        const mx = Math.min(Math.max(ax, 6), w - 6);
        const my = Math.min(Math.max(ay, 6), h - 6);
        ctx.fillStyle = '#e8b64c';
        ctx.beginPath();
        ctx.moveTo(mx, my - 5); ctx.lineTo(mx + 5, my);
        ctx.lineTo(mx, my + 5); ctx.lineTo(mx - 5, my);
        ctx.fill();
    }
    return Math.round(span);
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
        el('span', { className: 'name', textContent: `${e.z}/${e.x}/${e.y}` }),
        el('span', { className: 'jd-status', textContent: statusOf(e, doing) }),
        el('div', { className: 'jd-acts' }, ...jobButtons(e, acts, caps), go, shut));
}

// One job, whole. `rows` is the page of the queue it was opened from, and
// `atoms` its pieces, read once for the job that is open.
export function jobDetail(e, { rows, atoms, acts, caps, onGo, close, where,
    say, refresh, doing = '' }) {
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
    const span = drawWhere(canvas, e, where?.());
    node.querySelector('.jd-facts').replaceChildren(...placeRows(e, span));
    return node;
}
