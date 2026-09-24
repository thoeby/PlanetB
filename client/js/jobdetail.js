// jobdetail.js — one job opened (design 8f): where the tile is, what its
// pieces are, what has happened to it, and what it pays.
//
// It reads the pool row it was handed (db/0146 pool_row, which carries the
// tile's last events) and the job's atoms, which are public (db/0003_rls). It
// writes nothing except through the same RPCs the cards use — claim_for,
// retry_job, drop_job, redo_renders — and set_price / withdraw_price.

import { tileCenter } from '../lib/tilemath.js';
import { drawWhere } from './hudmap.js';
import { cr, el, far } from './poolui.js';
import { setPrice, withdrawPrice } from './wallet.js';
import { jobButtons, logRows, pieces, shotCanvas, statusOf, stepLine } from './poolcard.js';
import { shotWords } from './workshots.js';

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
        ['Price', Number(e.bounty) > 0 ? `${cr(e.bounty)} held for it` : 'free · nobody pays'],
    ].map(([k, v]) => el('div', { className: 'jd-fact' },
        el('span', { textContent: k }), el('span', { className: 'mono', textContent: v })));
}

// What to pay for this tile (PLAN-money.md §2). The price is cash, paid out of
// your wallet into a payment held with the job: the renderer's wallet collects
// it when the tile publishes, and uncollected it comes back by itself in a
// week. Withdrawing it is letting it come back now.
function priceCard(e, { say, refresh }) {
    const amount = el('input', { type: 'number', min: '0.01', step: '0.01', value: '10',
        className: 'po-amount', ariaLabel: 'price' });
    const priced = Number(e.bounty) > 0;
    const go = el('button', { type: 'button', className: 'po-set primary',
        textContent: priced ? 'Withdraw the price' : 'Put a price on it' });
    go.onclick = async () => {
        go.disabled = true;
        try {
            if (priced) await withdrawPrice(e.job);
            else await setPrice(e.job, Number(amount.value));
            say(priced ? 'the price is coming back to your wallet'
                : 'paid from your wallet and held until the tile publishes');
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        go.disabled = false;
        await refresh();
    };
    return el('div', { className: 'jd-card' },
        el('div', { className: 'wk-card-head' },
            el('span', { className: 'label', textContent: 'What to pay for it' })),
        el('div', { className: 'jd-price' }, priced ? null : amount, go),
        el('p', { className: 'note',
            textContent: priced ? `${cr(e.bounty)} is held for it. The renderer's wallet`
                + ' collects it when the tile publishes; nobody collects it in a week and'
                + ' it comes back to you.'
                : 'What you put on it leaves your wallet now and is held with the job.'
                + ' The renderer\'s wallet collects it when the tile publishes.' }));
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
