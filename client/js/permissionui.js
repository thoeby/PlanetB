// permissionui.js — what the Permission panel draws (design 3g). No requests:
// it is handed the candidates and the actions and returns nodes.

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const far = (m) => (!m ? 'here'
    : m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(1)} km away`);

const ago = (at) => {
    if (!at) return '';
    const mins = Math.round((Date.now() - Date.parse(at)) / 60000);
    if (!Number.isFinite(mins)) return '';
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export const tileId = (e) => `${e.z}/${e.x}/${e.y}`;

// Before / With candidate: the switch that decides which sha a loaded tile
// asks for, so the same walk shows the waiting version in place.
export function beforeWith(showing, onToggle) {
    const box = el('button', { type: 'button', className: 'switch',
        title: 'Show what is waiting, in place' });
    box.setAttribute('aria-checked', showing ? 'true' : 'false');
    box.onclick = () => onToggle(box.getAttribute('aria-checked') !== 'true');
    return el('div', { className: 'row-switch' },
        el('span', { textContent: showing
            ? 'With the candidate, in place' : 'Before — what is published' }),
        box);
}

// The list of what is waiting for this person, nearest first.
export function waiting(rows, chosen, onPick) {
    if (!rows) {
        return [el('li', { className: 'muted',
            textContent: 'Sign in to see what is waiting on your land.' })];
    }
    if (!rows.length) {
        return [el('li', { className: 'muted',
            textContent: 'Nothing waiting: every rendered tile on your land has'
                + ' been decided.' })];
    }
    return rows.map((e) => {
        const row = el('li', {},
            el('button', { className: 'bare', type: 'button' },
                el('div', { className: 'who' },
                    el('div', { className: 'name', textContent: tileId(e) }),
                    el('div', { className: 'sub',
                        textContent: `${far(e.metres)} · ${ago(e.at)}` }))),
            el('div', { className: 'end' },
                el('span', { className: 'chip',
                    'data-tone': e.was_published ? 'warn' : 'accent',
                    textContent: e.was_published ? 'replaces what is there'
                        : 'nothing there yet' })));
        row.setAttribute('aria-current', tileId(e) === chosen ? 'true' : 'false');
        row.querySelector('button').onclick = () => onPick(e);
        return row;
    });
}

// The decision itself: go and look, then yes or no, with the note a refusal
// carries back to whoever rendered it.
export function decide(entry, acts) {
    if (!entry) return [];
    const note = el('textarea', { rows: 2, className: 'pm-note',
        placeholder: 'A note back to whoever rendered it — required to refuse' });
    const go = el('button', { type: 'button', textContent: 'Go and look' });
    go.onclick = () => acts.go(entry);
    const yes = el('button', { type: 'button', className: 'pm-yes primary',
        textContent: 'Approve and publish' });
    yes.onclick = () => acts.approve(entry);
    const no = el('button', { type: 'button', className: 'pm-no',
        textContent: 'Refuse' });
    no.onclick = () => acts.refuse(entry, note.value);
    return [
        el('span', { className: 'label', textContent: `Decide on ${tileId(entry)}` }),
        el('div', { className: 'note',
            textContent: entry.was_published
                ? 'Approving replaces what everybody sees there now.'
                : 'Nothing is published there yet: approving is the first thing'
                  + ' anybody will see.' }),
        el('div', { className: 'row' }, go),
        note,
        el('div', { className: 'row' }, yes, no),
    ];
}
