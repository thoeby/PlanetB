// profileui.js — who you are in the world (design 5e): the face, the name, what
// you hold, and the land you hold it on.
//
// It reads and shows; it decides nothing. Signing in and out is Setup's, because
// that is where an account is made — this is what the account amounts to.

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const initials = (label) => {
    const word = String(label ?? '').split('@')[0];
    const parts = word.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const two = parts.length > 1 ? parts[0][0] + parts[1][0] : word.slice(0, 2);
    return (two || '—').toUpperCase();
};

const tile = (v, l, tone) => {
    const node = el('div', { className: 'tile' },
        el('div', { className: 'v', textContent: v }),
        el('div', { className: 'l', textContent: l }));
    if (tone) node.dataset.tone = tone;
    return node;
};

export function mountProfile(host, { claims = () => null, balance = () => null,
    lands = () => [], things = () => [], open = () => {} } = {}) {
    const face = el('div', { className: 'pr-face', textContent: '—' });
    const name = el('div', { className: 'pr-name', textContent: 'Nobody yet' });
    const role = el('span', { className: 'chip', textContent: 'anon' });
    const id = el('div', { className: 'sub mono' });
    const head = el('div', { className: 'pr-head' }, face,
        el('div', { className: 'pr-who' }, name,
            el('div', { className: 'spread' }, role), id));
    const counts = el('div', { className: 'tiles three' });
    const landList = el('ul', { className: 'rows' });
    const landLabel = el('span', { className: 'label', textContent: 'Your land' });
    const signIn = el('button', { type: 'button', textContent: 'Sign in · Setup' });
    signIn.onclick = () => open('Setup');
    const node = el('div', { className: 'profile' }, head, counts,
        el('div', { className: 'section' },
            el('div', { className: 'spread' }, landLabel), landList), signIn);
    host.append(node);

    function refresh() {
        const who = claims();
        const label = who?.email ?? (who?.sub ? 'signed in' : '');
        name.textContent = label || 'Nobody yet';
        face.textContent = initials(label);
        role.textContent = who?.role ?? 'anon';
        role.dataset.tone = who?.role === 'admin' ? 'warn'
            : who?.role === 'player' ? 'accent' : 'dim';
        id.textContent = who?.sub ? `id ${who.sub}` : 'not signed in';
        signIn.hidden = Boolean(who?.sub);
        const amount = balance();
        const mine = lands() ?? [];
        counts.replaceChildren(
            tile(amount === null || amount === undefined ? '—'
                : Number(amount).toFixed(2), 'Cash', 'accent'),
            tile(String(mine.length), 'Lands'),
            tile(String((things() ?? []).length), 'Things placed'));
        landLabel.textContent = mine.length ? 'Your land' : 'No land yet';
        landList.replaceChildren(...mine.map((a) => {
            const go = el('button', { type: 'button', className: 'bare',
                textContent: a.name ?? `area ${a.id}` });
            go.onclick = () => open('Your land');
            return el('li', {}, el('span', { className: 'who' },
                el('span', { className: 'name' }, go),
                el('span', { className: 'sub', textContent: `area ${a.id}` })),
            el('span', { className: 'end' },
                el('span', { className: 'muted',
                    textContent: `${a.contents?.length ?? 0} thing(s)` })));
        }));
    }

    refresh();
    return { refresh, node };
}
