// poolui.js — what the Submit and Render pool panels draw (designs 3e, 3f).
// Nodes only: pool.js keeps the requests and hands these what it has.

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

export const cr = (n) => (Number(n) || 0).toFixed(2);

export const far = (m) => (m === null || m === undefined ? ''
    : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

const tile = (v, l, tone) => el('div', { className: 'tile', 'data-tone': tone ?? '' },
    el('div', { className: 'v', textContent: String(v) }),
    el('div', { className: 'l', textContent: l }));

// ------------------------------------------------------------------ submit

// The four numbers area_progress reports, as the artboard groups them.
export function progressTiles(p) {
    if (!p) return [el('div', { className: 'muted', textContent: 'Pick a land above.' })];
    const waiting = Math.max(0, Number(p.waiting) - Number(p.open_jobs));
    return [
        tile(waiting, 'to submit'),
        // What this land is compiled into, not the ladder above it (db/0087).
        tile(p.leaves_published ?? p.published, 'compiled', 'accent'),
        tile(p.open_jobs, 'waiting in the pool', 'warn'),
        tile(cr(p.in_escrow), 'cr held for renderers', 'warn'),
    ];
}

// A price with the four the design offers and a reference for what the pool is
// actually paying, so 0 is a choice rather than a default nobody questioned.
export function priceRow(value, onPick) {
    const presets = el('div', { className: 'row' });
    for (const v of [0, 5, 10, 20]) {
        const b = el('button', { type: 'button', textContent: v === 0 ? 'free' : String(v) });
        if (Number(value) === v) b.dataset.on = '1';
        b.onclick = () => onPick(v);
        presets.append(b);
    }
    return presets;
}

export function poolReference(rows) {
    const paid = (rows ?? []).map((r) => Number(r.bounty)).filter((n) => n > 0);
    if (!paid.length) {
        return 'Nothing in the pool is paid for right now, so any price at all'
            + ' puts your land at the front of it.';
    }
    paid.sort((a, b) => a - b);
    const mid = paid[Math.floor(paid.length / 2)];
    return `The pool today: ${cr(paid[0])} – ${cr(paid.at(-1))} cr,`
        + ` ${cr(mid)} in the middle, over ${paid.length} paid tile(s).`;
}

export const totalLine = (n, price, balance) => [
    el('div', { className: 'spread' },
        el('span', { className: 'muted', textContent: `${n} tile(s) × ${cr(price)} cr` }),
        el('span', { style: 'font-family: var(--mono)', textContent: `${cr(n * price)} cr` })),
    el('div', { className: 'spread' },
        el('span', { className: 'muted',
            textContent: 'Held from your credits until rendered · balance after' }),
        el('span', { style: 'font-family: var(--mono); color: var(--accent)',
            textContent: `${cr(Number(balance) - n * price)} cr` })),
];

// -------------------------------------------------------------------- pool

// What a tile is waiting on, in words. A piece that failed three times is not
// handed out again (db/0005_state.sql), so a tile of nothing but those is
// stuck until somebody says try again.
//
// Ready and blocked are two numbers and not one (db/0087): a ready piece is
// work a tab can be handed, a blocked one is waiting on something else in the
// same tile — usually the piece that gave up. Counted together they read as
// "2 piece(s) to do" beside a Render button that could claim neither.
export const what = (e) => [
    e.ready ? `${e.ready} piece(s) to do` : '',
    e.blocked ? `${e.blocked} waiting on the rest` : '',
    e.claimed ? `${e.claimed} in hand` : '',
    e.failed ? `${e.failed} gave up` : '',
    // SPEC §3.12: a render somebody walked away from is back here, and says so
    // — otherwise the same row reads as work nobody has started.
    e.handed_back
        ? `handed back ${e.handed_back === 1 ? 'once' : `${e.handed_back} times`}`
            + ' by a tab that went away'
        : '',
].filter(Boolean).join(' · ');

// Nothing anybody's tab can be given: whatever is left is blocked behind a
// piece that gave up, or is in somebody else's hands. Not "failed and nothing
// else", which missed the ordinary shape of it — one atom failed and the two
// after it waiting on it for ever.
// What a tile is worth to look at once it lands. client/js/traverse.js refines
// a tile into its children only when every child the world knows about is
// published — an unpublished one that exists is a hole, and refining into it
// would tear the ground open — so one z16 of the sixteen under a z14 draws
// nothing at all. Minutes of training and no change in the world is not
// somebody doing it wrong, and the row says so rather than leaving them to
// work it out (db/0088).
export const drawnWhen = (e) => {
    const all = Number(e.siblings) || 0;
    const done = Number(e.siblings_published) || 0;
    if (all <= 1) return '';
    const left = Math.max(0, all - done - 1);
    return left
        ? `drawn once the ${left} beside it are too`
        : 'the last of its block — this one puts it on screen';
};

export const stuck = (e) => !e.ready && !e.claimed && (e.failed > 0 || e.blocked > 0);

// What this tab in particular cannot take, even though somebody could: the
// work that is ready needs a GPU this tab has not got, or buffers it cannot
// hold. Pressing Render would claim nothing and say so a minute later.
export const beyond = (e, caps) => Boolean(e.ready)
    && Boolean(e.needs_webgpu)
    && (!caps?.webgpu
        || (Number(e.needs_mb) > 0 && Number(caps.max_buffer_mb) > 0
            && Number(caps.max_buffer_mb) < Number(e.needs_mb)));

// What the tab is doing to this tile, in the words SPEC §3.7 uses.
export const DOING = {
    assemble: 'assembling', frame: 'framing', train: 'training',
    sample: 'sampling', merge: 'merging', sog: 'encoding', verify: 'checking',
};

// What this job needs of the machine, and what this machine has. A tab with no
// GPU is told next to the job rather than three minutes into it — and so is a
// tab whose GPU will not hand out a buffer the size the trainer needs, which
// used to read as a tick beside a job the tab could never take
// (db/0083_thetrainerasksforwhatitcanbeasked.sql).
export const needs = (e, caps) => {
    if (!e.needs_webgpu) return 'no GPU needed';
    if (!caps?.webgpu) return 'needs WebGPU \u2014 this tab has none';
    const mb = Number(e.needs_mb) || 0;
    const has = Number(caps.max_buffer_mb) || 0;
    if (mb && has && has < mb) {
        return `needs ${mb} MB buffers \u2014 this tab allows ${has} MB`;
    }
    return 'needs WebGPU \u2713';
};

// One open job, as the artboard's row: what and where on the left, what it
// pays and the button on the right.
export function poolRow(e, acts, caps, picked = null) {
    const render = el('button', { type: 'button', className: 'po-render primary',
        textContent: 'Render' });
    render.onclick = () => acts.render(e, render);
    const end = el('div', { className: 'end' },
        el('span', { style: `color: var(--${Number(e.bounty) > 0 ? 'warn' : 'ink-3'})`,
            textContent: Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free' }));
    // What this row offers: the piece that gave up put back, where that is
    // yours to do; nothing at all where it is somebody else's; and Render only
    // where there is something a tab could actually be handed.
    if (e.failed > 0 && e.may_retry) {
        const again = el('button', { type: 'button', className: 'po-retry',
            textContent: 'Try again' });
        again.onclick = () => acts.retry(e, again);
        end.append(again);
    } else if (stuck(e)) {
        end.append(el('span', { className: 'chip', 'data-tone': 'bad',
            textContent: e.failed > 0 ? 'stopped \u00b7 its owner can try again'
                : 'waiting on itself' }));
    } else if (beyond(e, caps)) {
        end.append(el('span', { className: 'chip', 'data-tone': 'warn',
            textContent: 'not this machine' }));
    } else {
        end.append(render);
    }
    const li = el('li', {},
        el('div', { className: 'who' },
            el('div', { className: 'name',
                textContent: `${e.z}/${e.x}/${e.y}` }),
            el('div', { className: 'sub',
                // What this job makes is the job's own answer: a tile with
                // nothing under it is assembled whatever its zoom
                // (db/0045_coarseleaf.sql).
                textContent: [far(e.metres), what(e), e.made, needs(e, caps),
                    drawnWhen(e)].filter(Boolean).join(' · ') })),
        end);
    // Picking a row is how a price goes on that tile (client/js/renderpool.js).
    // The money belongs beside the queue it moves you up, not in the wallet,
    // which had no way of knowing which tile you meant.
    if (acts.pick) {
        li.setAttribute('aria-current', String(e.job === picked));
        li.onclick = (event) => {
            if (event.target.closest('button')) return;
            acts.pick(e);
        };
    }
    return li;
}
