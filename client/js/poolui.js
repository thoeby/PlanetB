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
    if (!p) return [el('div', { className: 'muted', textContent: 'Pick some land.' })];
    const waiting = Math.max(0, Number(p.waiting) - Number(p.open_jobs));
    return [
        tile(waiting, 'to submit'),
        tile(p.published, 'compiled', 'accent'),
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
export const what = (e) => [
    e.ready ? `${e.ready} piece(s) to do` : '',
    e.claimed ? `${e.claimed} in hand` : '',
    e.failed ? `${e.failed} gave up` : '',
].filter(Boolean).join(' · ');

export const stuck = (e) => e.failed > 0 && !e.ready && !e.claimed;

// What the tab is doing to this tile, in the words SPEC §3.7 uses.
export const DOING = {
    assemble: 'assembling', frame: 'framing', train: 'training',
    sample: 'sampling', merge: 'merging', sog: 'encoding', verify: 'checking',
};

// What this job needs of the machine, and what this machine has. A tab with no
// GPU is told next to the job rather than three minutes into it.
export const needs = (e, caps) => (e.needs_webgpu
    ? (caps?.webgpu ? 'needs WebGPU \u2713' : 'needs WebGPU \u2014 this tab has none')
    : 'no GPU needed');

// One open job, as the artboard's row: what and where on the left, what it
// pays and the button on the right.
export function poolRow(e, acts, caps) {
    const render = el('button', { type: 'button', className: 'po-render primary',
        textContent: 'Render' });
    render.onclick = () => acts.render(e, render);
    const end = el('div', { className: 'end' },
        el('span', { style: `color: var(--${Number(e.bounty) > 0 ? 'warn' : 'ink-3'})`,
            textContent: Number(e.bounty) > 0 ? `${cr(e.bounty)} cr` : 'free' }));
    if (e.failed > 0 && e.may_retry) {
        const again = el('button', { type: 'button', className: 'po-retry',
            textContent: 'Try again' });
        again.onclick = () => acts.retry(e, again);
        end.append(again);
    } else if (stuck(e)) {
        end.append(el('span', { className: 'chip', 'data-tone': 'bad',
            textContent: 'stopped' }));
    } else {
        end.append(render);
    }
    return el('li', {},
        el('div', { className: 'who' },
            el('div', { className: 'name',
                textContent: `${e.z}/${e.x}/${e.y}` }),
            el('div', { className: 'sub',
                // What this job makes is the job's own answer: a tile with
                // nothing under it is assembled whatever its zoom
                // (db/0045_coarseleaf.sql).
                textContent: [far(e.metres), what(e), e.made, needs(e, caps)]
                    .filter(Boolean).join(' · ') })),
        end);
}
