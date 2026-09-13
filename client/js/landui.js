// landui.js — what the Your land panel draws (design 3b). No requests and no
// state: it is handed what land.js has and returns nodes, so the shape of the
// panel is one readable file and the data is another.
//
// Who may touch this land, and how many have to say yes, is client/js/landpeople.js.

import { approvals, people } from './landpeople.js';

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const name = (a) => a?.rules?.name || 'unnamed land';

// Owner · Direct edit · Propose — the right you hold here, in the design's
// colours: cyan for yours, amber for a grant, grey for somebody else's.
function role(area) {
    if (area.mine) return { words: 'Owner', tone: 'accent' };
    if (area.may_write) return { words: 'Direct edit', tone: 'accent' };
    if (area.may_propose) return { words: 'Propose', tone: 'warn' };
    return { words: 'Read only', tone: 'dim' };
}

const short = (id) => String(id ?? '').slice(0, 8).toUpperCase();

// The list at the top: every area, the one chosen marked.
export function landRows(state, onPick) {
    if (!state.areas.length) {
        return [el('li', { className: 'muted',
            textContent: 'No land yet — ask for some below.' })];
    }
    return state.areas.map((a) => {
        const r = role(a);
        const row = el('li', {},
            el('button', { className: 'bare', type: 'button' },
                el('div', { className: 'who' },
                    el('div', { className: 'name', textContent: name(a) }),
                    el('div', { className: 'sub',
                        textContent: `${short(a.id)} · detail ${a.detail}` }))),
            el('div', { className: 'end' },
                el('span', { className: `role ${r.tone === 'accent' ? 'cyan' : ''}`,
                    textContent: r.words, style: `color: var(--${
                        r.tone === 'accent' ? 'accent' : r.tone === 'warn' ? 'warn' : 'ink-3'})` }),
                el('span', { className: 'muted',
                    textContent: a.id === state.chosen && state.progress
                        ? `${state.progress.published} of ${state.progress.tiles} compiled`
                        : '' })));
        row.setAttribute('aria-current', a.id === state.chosen ? 'true' : 'false');
        row.querySelector('button').onclick = () => onPick(a);
        return row;
    });
}

// The card under it: the one area, what stands on it, and what it is waiting
// for. Everything here is the artboard's, in its order.
export function selected(area, state, ctx) {
    if (!area) return [];
    return [
        head(area, state, ctx),
        refused(state.refusal),
        counts(state.progress, ctx),
        howFine(area, ctx),
        shapeInQgis(area, ctx),
        approvals(area, ctx),
        people(area, state, ctx),
        proposals(state),
        drawn(state, ctx),
        contents(state, ctx),
    ].filter(Boolean);
}

// How fine this land is compiled (`area.detail`, SPEC §0.1). It decides what
// the smallest tile on it is, and so how much of a splat a square metre gets:
// the whole reason a piece of ground can look like a smear from standing
// height. Finer than 14 is trained rather than sampled, which asks for a GPU
// in whichever tab takes the job — said here rather than discovered three
// minutes into a render.
const FINE = [
    { detail: 10, words: '10 — 7 km tiles, a region seen from the air' },
    { detail: 12, words: '12 — 3.4 km tiles' },
    { detail: 14, words: '14 — 1.7 km tiles, the baseline' },
    { detail: 16, words: '16 — 430 m tiles, trained (needs a GPU)' },
    { detail: 18, words: '18 — 107 m tiles, street level, trained (needs a GPU)' },
];

function howFine(area, ctx) {
    if (!area.mine) return null;
    const pick = el('select', { className: 'land-fine' });
    pick.append(...FINE.map((f) => new Option(f.words, String(f.detail),
        false, f.detail === area.detail)));
    const status = el('p', { className: 'status land-fine-status' });
    pick.onchange = () => finer(area, Number(pick.value), status, ctx);
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'How fine' }),
        pick,
        el('div', { className: 'note' },
            'Deeper compiles the ground again: the tiles it adds are changed,'
            + ' and go through Submit like anything else.'),
        status);
}

async function finer(area, detail, status, ctx) {
    status.dataset.bad = '';
    status.textContent = 'asking the world\u2026';
    try {
        const n = await ctx.api.rpc('set_area_detail',
            { area_id: area.id, detail });
        status.textContent = n
            ? `${n} tile(s) to compile at detail ${detail} \u2014 submit them when you are ready`
            : `detail ${detail}. Nothing new to compile: it was already finer.`;
        await ctx.refresh?.();
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
    }
}

// SPEC §2.11: a button that downloads a QGIS project already connected to this
// world — as you — and next to it the three steps, one line each. Nothing
// about terminals.
//
// The project carries the player's own database login, so it cannot be a plain
// link: it is fetched with the token the tab already holds and handed to the
// browser as a file.
function shapeInQgis(area, ctx) {
    if (!area.may_write) return null;
    const get = el('button', { type: 'button', className: 'primary',
        textContent: 'Shape this land in QGIS' });
    const status = el('p', { className: 'status qgis-status' });
    get.onclick = () => downloadProject(ctx, status);
    return el('div', { className: 'section qgis' },
        el('span', { className: 'label', textContent: 'Shape it' }),
        get,
        el('ol', { className: 'rows qgis-steps' },
            el('li', {}, 'Open the downloaded project in QGIS.'),
            el('li', {}, 'Draw on a layer — a wood, a road, a tree.'),
            el('li', {}, 'Save. This page has it within half a minute.')),
        status);
}

async function downloadProject(ctx, status) {
    status.textContent = 'asking the world for a project\u2026';
    status.dataset.bad = '';
    try {
        const file = await ctx.api.fetchFile('/qgis/project.qgs');
        const url = URL.createObjectURL(file);
        const link = el('a', { href: url, download: 'splatworld.qgs' });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        status.textContent = 'Downloaded. Open it in QGIS.';
    } catch (err) {
        status.textContent = String(err.body?.error ?? err.message ?? err);
        status.dataset.bad = '1';
    }
}

function head(area, state, ctx) {
    const go = el('button', { type: 'button', textContent: 'Go there' });
    go.onclick = () => ctx.onGo(area.centre ?? {});
    const rename = el('button', { type: 'button', textContent: 'Rename' });
    rename.onclick = () => renameArea(area, ctx);
    return el('div', { className: 'section' }, el('div', { className: 'spread' },
        el('div', {},
            el('span', { className: 'label', textContent: 'Selected land' }),
            el('div', { className: 'name',
                style: 'font-family: var(--head); font-weight: 700;'
                    + ' font-size: 22px; text-transform: uppercase;'
                    + ' letter-spacing: 0.06em; line-height: 1.1',
                textContent: name(area) })),
        el('div', { style: 'display:flex; gap:6px' }, area.mine ? rename : null, go)));
}

async function renameArea(area, ctx) {
    const next = globalThis.prompt('Name this land', area.rules?.name ?? '');
    if (!next) return;
    try {
        await ctx.api.rpc('create_area', { area_id: area.id, name: next });
        ctx.say(`renamed to ${next}`);
    } catch {
        // create_area is for drawing; naming an existing one is a rules edit.
        try {
            await ctx.api.update('area', { id: `eq.${area.id}` },
                { rules: { ...(area.rules ?? {}), name: next } });
            area.rules = { ...(area.rules ?? {}), name: next };
            ctx.say(`renamed to ${next}`);
        } catch (err) {
            ctx.say(String(err.body?.message ?? err.message ?? err), true);
        }
    }
    await ctx.refresh();
}

// Published · Candidates · Unsubmitted · In the pool, as the artboard counts
// them. area_progress is the only source; nothing is inferred.
function counts(p, ctx) {
    if (!p) return null;
    const tile = (v, l, tone) => el('div', { className: 'tile', 'data-tone': tone ?? '' },
        el('div', { className: 'v', textContent: String(v) }),
        el('div', { className: 'l', textContent: l }));
    const changed = Math.max(0, Number(p.to_submit ?? 0));
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'Tiles on this land' }),
        el('div', { className: 'tiles' },
            tile(p.published, 'Published', 'accent'),
            tile(changed, 'Unsubmitted'),
            tile(p.awaiting ?? 0, 'Awaiting approval', 'warn'),
            tile(p.open_jobs, 'In the pool', 'warn'),
            tile(p.tiles, 'Tiles in all')),
        changedLine(changed, ctx),
        awaitingLine(p.awaiting ?? 0));
}

// SPEC §3.6: "Ben sees the note on the land card and on each refused object."
// The card half.
function refused(refusal) {
    if (!refusal?.note) return null;
    return el('div', { className: 'section land-refused' },
        el('span', { className: 'label', textContent: 'Refused' }),
        el('p', {}, refusal.note),
        el('div', { className: 'muted', textContent: `\u2014 ${refusal.by}` }));
}

// SPEC §0.2: a tile somebody has been asked about says so, in words.
function awaitingLine(awaiting) {
    if (!awaiting) return null;
    return el('div', { className: 'land-awaiting' },
        `${awaiting} tile${awaiting === 1 ? '' : 's'} awaiting approval`);
}

// SPEC §3.3 step 4 and §3.5: what you changed and the one thing to do about
// it, in words, on the card — a column of four numbers is not a sentence.
function changedLine(changed, ctx) {
    if (!changed) return null;
    const submit = el('button', { type: 'button', className: 'primary',
        textContent: 'Submit' });
    submit.onclick = () => ctx?.openPanel?.('Submit');
    return el('div', { className: 'land-changed' },
        el('span', { textContent: `${changed} tile${changed === 1 ? '' : 's'}`
            + ' changed' }), submit);
}

// How many people have to say yes before a rendered tile is published.
function proposals(state) {
    const open = (state.proposals ?? []).filter((p) => p.state === 'open');
    if (!open.length) return null;
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'Proposals on this land' }),
        el('ul', { className: 'rows' }, ...open.map((p) => el('li', {},
            el('div', { className: 'who' },
                el('div', { className: 'name',
                    textContent: `${short(p.id)} · ${p.title ?? 'a change'}` }),
                el('div', { className: 'sub', textContent: p.author_email ?? '' })),
            el('span', { className: 'chip', 'data-tone': 'warn',
                textContent: 'awaiting a decision' })))));
}

// What was drawn in QGIS. Not instances: these are the roads, woods, water and
// buildings the world is actually made of, and the panel said nothing about
// them until db/0059.
function drawn(state, ctx) {
    const kinds = state.drawn ?? [];
    if (!kinds.length) return null;
    return el('div', { className: 'section land-drawn' },
        el('span', { className: 'label', textContent: 'Drawn in QGIS' }),
        el('ul', { className: 'rows' }, ...kinds.map((k) => {
            const go = el('button', { className: 'bare', type: 'button' },
                el('div', { className: 'who' },
                    el('div', { className: 'name', textContent: k.kind }),
                    el('div', { className: 'sub', textContent:
                        `${Number(k.lat).toFixed(4)}, ${Number(k.lon).toFixed(4)}` })));
            go.onclick = () => ctx.onGo(k);
            return el('li', {}, go,
                el('div', { className: 'end' },
                    el('span', { className: 'chip', 'data-tone': 'dim',
                        textContent: `${k.count}` })));
        })));
}

// And, last, the things standing on it.
function contents(state, ctx) {
    const rows = el('ul', { className: 'rows' });
    rows.replaceChildren(...(state.contents ?? []).map((item) => {
        const go = el('button', { className: 'bare', type: 'button' },
            el('div', { className: 'who' },
                el('div', { className: 'name',
                    textContent: item.name || item.san || 'something' }),
                el('div', { className: 'sub', textContent:
                    `${Number(item.lat).toFixed(4)}, ${Number(item.lon).toFixed(4)}` })));
        go.onclick = () => ctx.onGo(item);
        const end = el('div', { className: 'end' },
            el('span', { className: 'chip', 'data-tone': 'warn',
                textContent: 'not yet rendered' }));
        if (item.mine) {
            const off = el('button', { type: 'button', textContent: 'remove' });
            off.onclick = () => ctx.onRemove(item);
            end.append(off);
        }
        return el('li', {}, go, end);
    }));
    if (!(state.contents ?? []).length) {
        rows.append(el('li', { className: 'muted',
            textContent: 'Nothing stands on it yet — the Place tab puts'
                + ' something here.' }));
    }
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: "What's on it" }), rows);
}
