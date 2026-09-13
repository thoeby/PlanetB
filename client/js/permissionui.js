// permissionui.js — what the Approve panel draws (design 3g, SPEC §2.9).
//
// No state and no requests: it is handed the submissions waiting for this
// player and returns nodes. permission.js does the asking and the deciding.

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const ago = (at) => {
    const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    if (seconds < 90) return 'just now';
    if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
    return `${Math.round(seconds / 3600)} h ago`;
};

// "3 tiles · 2 objects · 1 wood" — what the approver is being asked about.
export function changeWords(entry) {
    const c = entry.changes ?? {};
    const bits = [`${entry.tiles} tile${entry.tiles === 1 ? '' : 's'}`];
    if (c.objects) bits.push(`${c.objects} object${c.objects === 1 ? '' : 's'}`);
    if (c.moved) bits.push(`${c.moved} moved`);
    if (c.features) bits.push(`${c.features} drawn`);
    return bits.join(' · ');
}

// The list: what is waiting for me, and who sent it.
export function waiting(rows, chosen, onPick) {
    if (!rows?.length) {
        return [el('li', { className: 'muted',
            textContent: 'Nothing is waiting for your decision.' })];
    }
    return rows.map((entry) => {
        const pick = el('button', { className: 'bare', type: 'button' },
            el('div', { className: 'who' },
                el('div', { className: 'name', textContent: entry.land }),
                el('div', { className: 'sub',
                    textContent: `by ${entry.by} · ${ago(entry.at)}` })));
        pick.onclick = () => onPick(entry);
        const row = el('li', {}, pick,
            el('div', { className: 'end' },
                el('span', { className: 'muted', textContent: changeWords(entry) }),
                entry.superseded
                    ? el('span', { className: 'chip', 'data-tone': 'warn',
                        textContent: 'changed since' })
                    : null));
        row.setAttribute('aria-current', String(entry.id === chosen));
        return row;
    });
}

// Before / After: what is on the land now, and what it looked like without
// what was built (SPEC §2.9). It hides and shows the models in place.
export function beforeAfter(after, onSwitch) {
    const box = el('div', { className: 'row-switch pm-beforeafter' },
        el('span', { textContent: after ? 'After — what was built' : 'Before' }));
    const input = el('input', { type: 'checkbox', className: 'pm-after',
        checked: after });
    input.onchange = () => onSwitch(input.checked);
    box.append(input);
    return box;
}

// The card: what this submission is, and the three things to do about it.
export function decide(entry, acts) {
    if (!entry) return [];
    const note = el('input', { type: 'text', className: 'pm-note',
        placeholder: 'why not? (a sentence)' });
    const review = el('button', { type: 'button', textContent: 'Review' });
    const yes = el('button', { type: 'button', className: 'primary',
        textContent: 'Approve' });
    const no = el('button', { type: 'button', textContent: 'Refuse' });
    review.onclick = () => acts.review(entry);
    yes.onclick = () => acts.approve(entry);
    no.onclick = () => acts.refuse(entry, note.value);
    return [el('div', { className: 'section pm-card' },
        el('span', { className: 'label', textContent: 'This submission' }),
        el('div', { className: 'name', textContent: entry.land }),
        el('div', { className: 'muted',
            textContent: `by ${entry.by} · ${changeWords(entry)}` }),
        entry.note ? el('p', { className: 'pm-said', textContent: entry.note }) : null,
        entry.superseded
            ? el('p', { className: 'status', 'data-bad': '1',
                textContent: 'This changed since it was submitted — ask for it'
                    + ' again.' })
            : null,
        el('div', { className: 'row' }, review, yes),
        note, no)];
}
