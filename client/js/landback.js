// landback.js — giving land back, from the Land panel (PLAYER-RUN story 11).
//
// Two presses, never one: the first asks the world what would go and says it
// in a sentence, the second does it. What goes is counted by the database
// (db/0077_givingitback.sql `land_removal`), not guessed here, so the sentence
// somebody agrees to is the deed that follows it.
//
// Which of the two presses this land is between lives in the panel's state,
// not in these nodes: the card is redrawn whenever the land under you changes
// and every ten seconds besides, and a confirmation held in the node it drew
// is a confirmation that disappears under the hand reaching for it.

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "Ben's field goes, and with it 3 objects and 1 shape drawn in QGIS.
//  2 published tiles return to ground."
export function whatGoes(w) {
    const parts = [];
    if (w.objects) parts.push(plural(w.objects, 'object', 'objects'));
    if (w.features) parts.push(plural(w.features, 'shape drawn in QGIS',
        'shapes drawn in QGIS'));
    if (w.grants) parts.push(plural(w.grants, 'grant', 'grants'));
    const with_ = parts.length
        ? `, and with it ${parts.slice(0, -1).join(', ')}${
            parts.length > 1 ? ' and ' : ''}${parts.at(-1)}`
        : ', and nothing stands on it';
    const tiles = w.tiles
        ? ` ${plural(w.tiles, 'published tile', 'published tiles')} `
            + `${w.tiles === 1 ? 'returns' : 'return'} to ground.`
        : ' Nothing has been rendered on it.';
    return `${w.land} goes${with_}.${tiles}`;
}

// `asked` is what the panel holds between the two presses: the land it is
// about and what the world said would go with it.
export function givingBack(area, ctx, asked = null) {
    if (!area?.mine) return null;
    const status = el('p', { className: 'status land-back-status' });
    const between = asked?.id === area.id ? asked : null;
    const start = el('button', { type: 'button', className: 'land-back',
        textContent: 'Give this land back', hidden: Boolean(between) });
    start.onclick = () => ask(area, status, ctx);
    return el('div', { className: 'section land-back-section' },
        el('span', { className: 'label', textContent: 'Give it back' }),
        el('div', { className: 'note' },
            'The land stops being yours. What stands on it goes with it and'
            + ' its tiles return to ground.'),
        start, between ? confirmation(area, between, status, ctx) : null, status);
}

function confirmation(area, went, status, ctx) {
    const yes = el('button', { type: 'button', className: 'land-back-yes primary',
        textContent: 'Yes, give it back' });
    const no = el('button', { type: 'button', className: 'land-back-no',
        textContent: 'Keep it' });
    no.onclick = () => ctx.confirming?.(null);
    yes.onclick = () => give(area, yes, no, status, ctx);
    return el('div', { className: 'land-back-confirm' },
        el('p', { className: 'land-back-what', textContent: whatGoes(went) }),
        el('div', { style: 'display:flex; gap:6px' }, yes, no));
}

async function ask(area, status, ctx) {
    status.dataset.bad = '';
    status.textContent = 'asking the world what would go…';
    try {
        const went = await ctx.api.rpc('land_removal', { area_id: area.id });
        ctx.confirming?.({ ...went, id: area.id });
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
    }
}

async function give(area, yes, no, status, ctx) {
    yes.disabled = true;
    no.disabled = true;
    status.dataset.bad = '';
    status.textContent = 'giving it back…';
    try {
        const went = await ctx.api.rpc('remove_area', { area_id: area.id });
        ctx.confirming?.(null);
        ctx.say(`${went?.land ?? 'that land'} is gone — its tiles are ground again`);
        await ctx.reload?.();
    } catch (err) {
        status.textContent = String(err.body?.message ?? err.message ?? err);
        status.dataset.bad = '1';
        yes.disabled = false;
        no.disabled = false;
    }
}
