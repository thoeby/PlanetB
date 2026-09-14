// landfine.js — how this land is compiled, and asking for it again.
//
// Two controls that belong together and nowhere else: how deep the tiles go,
// and "build it all again" for when the world's recipe moved under ground that
// did not. Split out of client/js/landui.js when the card outgrew four hundred
// lines.

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// How fine this land may be compiled (`area.detail`, SPEC §0.1). A ceiling, not
// a quota: the depth is earned by what stands on the ground (db/0089), because
// a tile finer than the baseline is a training job — 120 rendered views and
// 7000 iterations — and empty ground does not need one to say what the
// elevation model already says exactly.
//
//     up to 14   every tile of the land, sampled, no GPU anywhere
//     16         where something drawn or placed stands
//     18         where something with walls stands: a footprint, or anything
//                put down from the catalog
const FINE = [
    { detail: 10, words: '10 — 7 km tiles, a region seen from the air' },
    { detail: 12, words: '12 — 3.4 km tiles' },
    { detail: 14, words: '14 — 1.7 km tiles, the baseline' },
    { detail: 16, words: '16 — 430 m where something stands (needs a GPU)' },
    { detail: 18, words: '18 — 107 m where something has walls (needs a GPU)' },
];

export function howFine(area, ctx) {
    if (!area.mine) return null;
    const pick = el('select', { className: 'land-fine' });
    pick.append(...FINE.map((f) => new Option(f.words, String(f.detail),
        false, f.detail === area.detail)));
    const status = ctx.keep('fine-status',
        () => el('p', { className: 'status land-fine-status' }));
    pick.onchange = () => finer(area, Number(pick.value), status, ctx);
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'How fine' }),
        pick,
        el('div', { className: 'note' },
            'A ceiling, not a quota: the ground is compiled to 14 everywhere,'
            + ' and finer only where something stands on it. The tiles it adds'
            + ' are changed and go through Submit like anything else. Anything'
            + ' already in the pool for this land is cancelled \u2014 it was'
            + ' building the version you have just replaced \u2014 and its'
            + ' escrow comes back.'),
        status, again(area, ctx));
}

// Nothing about the land changed, but the world's recipe did — a rule, or the
// sampler itself. This is how you get the tiles built the new way: it marks
// the ground changed, and from there it is Submit and an approval like
// anything else (db/0081_compileitagain.sql).
function again(area, ctx) {
    const status = ctx.keep('again-status',
        () => el('p', { className: 'status land-again-status' }));
    const go = el('button', { type: 'button', className: 'land-again',
        textContent: 'Compile it all again' });
    go.onclick = () => compileAgain(area, go, status, ctx);
    return el('div', { className: 'land-again-box' },
        go,
        el('div', { className: 'note' },
            'Builds every tile of this land from what is on it now, even the'
            + ' ones already rendered. Use it when the world looks different'
            + ' from how it was compiled. Jobs open on the old version are'
            + ' cancelled first, and their escrow comes back.'),
        status);
}

async function compileAgain(area, go, status, ctx) {
    go.disabled = true;
    status.dataset.bad = '';
    status.textContent = 'marking the ground\u2026';
    try {
        const n = await ctx.api.rpc('recompile_land', { area_id: area.id });
        status.textContent = `${n} tile(s) to build again \u2014 submit them when`
            + ' you are ready';
        await ctx.refresh?.();
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
    }
    go.disabled = false;
}

async function finer(area, detail, status, ctx) {
    status.dataset.bad = '';
    status.textContent = 'asking the world\u2026';
    try {
        const n = await ctx.api.rpc('set_area_detail',
            { area_id: area.id, detail });
        status.textContent = n
            ? `${n} tile(s) to compile at detail ${detail} \u2014 submit them when you are ready`
            : `detail ${detail}. Nothing new: the ceiling is up, and nothing on`
                + ' this land earns a finer tile yet. Draw or place something'
                + ' and the tiles under it appear.';
        await ctx.refresh?.();
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
    }
}
