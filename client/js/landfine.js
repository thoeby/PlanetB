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
            'Deeper compiles the ground again: the tiles it adds are changed,'
            + ' and go through Submit like anything else.'),
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
            + ' from how it was compiled.'),
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
            : `detail ${detail}. Nothing new to compile: it was already finer.`;
        await ctx.refresh?.();
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
    }
}
