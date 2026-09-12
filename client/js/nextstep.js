// nextstep.js — the card in the corner of the World (design 3a): the four
// steps a piece of land goes through, which one it is on, and the one button
// that does the next thing.
//
// It replaces the sentence that used to sit over the crosshair. The sentence
// said what was missing; this says the same thing as a route, so somebody who
// has done step one can see that step two is theirs.

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// The four steps, and for each: is it done, and what does it say. `counts` is
// what the panels already report — objects on the land, tiles changed, tiles
// in the pool, candidates waiting for a person.
export function steps({ things = 0, changed = 0, open = 0, waiting = 0,
    published = 0 } = {}) {
    return [
        {
            name: 'Draw',
            done: things > 0 || changed > 0 || published > 0,
            note: things ? `${things} thing(s) on your land`
                : 'draw a road, a wood or a building in QGIS',
            panel: 'Your land',
        },
        {
            name: 'Submit',
            done: changed === 0 && (open > 0 || published > 0),
            note: changed ? `${changed} tile(s) nobody else can see yet`
                : 'nothing waiting to be sent',
            panel: 'Submit',
        },
        {
            name: 'Render',
            done: open === 0 && published > 0,
            note: open ? `${open} tile(s) in the pool`
                : 'the pool, or this machine',
            panel: 'Render pool',
        },
        {
            name: 'Approve',
            done: waiting === 0 && published > 0,
            note: waiting ? `${waiting} waiting for you`
                : 'then everybody sees it',
            panel: 'Permission',
        },
    ];
}

// The first step that is not done is the one to do; when they are all done
// there is nothing to say and the card goes away.
export const nextOf = (list) => list.find((s) => !s.done) ?? null;

export function mountNextStep(host, { open = () => {} } = {}) {
    const list = el('div', { className: 'steps' });
    const act = el('button', { type: 'button', className: 'primary' });
    const title = el('span', { className: 'label', textContent: 'Next here' });
    const hide = el('button', { type: 'button', className: 'close', textContent: '×',
        title: 'hide · H' });
    const node = el('div', { id: 'next', className: 'glass' },
        el('div', { className: 'spread' }, title, hide), list, act);
    node.hidden = true;
    host.append(node);

    let shown = true;
    hide.onclick = () => { shown = false; node.hidden = true; };

    function show(counts, land) {
        const list_ = steps(counts);
        const next = nextOf(list_);
        title.textContent = land ? `Next on ${land}` : 'Next here';
        node.hidden = !shown || !next;
        if (node.hidden) return next;
        list.replaceChildren(...list_.map((s, i) => el('div', {
            className: 's', 'data-done': s.done ? '1' : '',
            'data-now': s === next ? '1' : '',
        }, el('span', { className: 'n', textContent: s.done ? '✓' : String(i + 1) }),
        el('span', { className: 'muted', textContent: s.name }),
        el('span', { textContent: s.note }))));
        act.textContent = `${next.name} · ${KEY[next.panel] ?? ''}`.trim();
        act.onclick = () => open(next.panel);
        return next;
    }

    return { show, node, again: () => { shown = true; } };
}

// The key that opens the panel a step leads to, so the button teaches it.
const KEY = {
    'Your land': '2', Place: '3', Submit: '5', 'Render pool': '6',
    Permission: '7',
};
