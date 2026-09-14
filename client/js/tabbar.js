// tabbar.js — the plinth along the bottom of the window: every surface the
// game has, in the order a person meets them.
//
// Three groups, because the eleven things this tool does are not eleven kinds
// of thing. `you` is who you are and what you have. `main` is the five surfaces
// the game is actually played through, on keys 1–5. `system` is the small set
// that is set once and left alone. Taken from docs/design/chrome5.dc.html.

// One drawn glyph per surface, so a surface is recognised before it is read.
// Stroked paths on a 24 box, the whole set from one hand.
const ICONS = {
    Profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
    Wallet: 'M21 12V7H5a2 2 0 0 1 0-4h14v4|M3 5v14a2 2 0 0 0 2 2h16v-5'
        + '|M18 12a2 2 0 0 0 0 4h4v-4Z',
    Place: 'm15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9|M17.6 15 22 10.6'
        + '|m20.9 11.7-1.3-1.3a3 3 0 0 1-.9-2.2v-.9L16 4.6A5.6 5.6 0 0 0 12 3H9l.9.8'
        + 'A6.2 6.2 0 0 1 12 8.4V10l2 2h2.5l2.3 1.9',
    Catalog: 'M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0'
        + ' 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z|m3.3 7 8.7 5 8.7-5'
        + '|M12 22V12',
    'Your land': 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z|M9 3v15|M15 6v15',
    Publish: 'm22 2-7 20-4-9-9-4Z|M22 2 11 13',
    Work: 'M2 7h20v14H2z|M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16|M2 13h20',
    Setup: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
    Share: 'M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'
        + '|M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6|m8.6 13.5 6.8 4M15.4 6.5l-6.8 4',
    Admin: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0'
        + ' 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0'
        + ' 0 1 1 1z',
};

export const GROUPS = ['you', 'main', 'system'];

// `parts` are the tabs inside a surface: two things that are one job — what you
// send to be rendered and what comes back for you to say yes to — belong behind
// one button, not two. Each part keeps its own name, because that is what the
// rest of the app and the stories call it.
export const TABS = [
    { name: 'World', group: null, lede: '' },
    { name: 'Profile', group: 'you', key: 'p', width: 470,
        lede: 'Who you are in the world, and what you hold.' },
    { name: 'Wallet', group: 'you', key: '6', width: 500, small: true,
        lede: 'What you have, and what moved.' },
    { name: 'Place', group: 'main', key: '1', width: 470,
        lede: 'Put a product from the catalog on your own land.' },
    { name: 'Catalog', group: 'main', key: '2', width: 666,
        lede: 'Products anyone may build with. Register your own.' },
    { name: 'Your land', group: 'main', key: '3', label: 'Land', width: 500,
        lede: 'The ground you own, and what stands on it.' },
    { name: 'Publish', group: 'main', key: '4', width: 500,
        parts: [{ name: 'Submit', label: 'Submit' },
            { name: 'Permission', label: 'Approve' }] },
    // Work is a surface with queues behind it, not one list. The machine
    // strip is the surface's own head (hud.js panelHead) because what this tab
    // can do is the same answer whichever queue is open; the queues are parts.
    // Render jobs is the only one so far.
    { name: 'Work', group: 'main', key: '5', width: 760,
        parts: [{ name: 'Render jobs', label: 'Render jobs' }] },
    { name: 'Setup', group: 'system', key: '`', width: 470,
        lede: 'Your account, your GeoServer, and the ground the world sits on.' },
    { name: 'Share', group: 'system', key: '9', width: 470,
        lede: 'A link that puts somebody else where you are standing.' },
    // Two jobs, not one. Land is a map and a form and wants the window; the
    // vocabulary is two lists side by side. Both were one column doing all of
    // it (`wide` takes the screen, hud.js showPanel).
    { name: 'Admin', group: 'system', key: '0', wide: true,
        parts: [{ name: 'Land', label: 'Land' },
            { name: 'Vocabulary', label: 'Vocabulary' }] },
];

// What a part is for, said where the part is opened rather than on the button
// that opens the surface.
export const PART_LEDE = {
    Submit: 'Send what you placed to be rendered.',
    Permission: 'What somebody built, waiting for a person to say yes.',
    'Render jobs': 'Tiles waiting to be compiled, and what they pay.',
    Land: 'Who is waiting for land, the ground it would be drawn on, and every'
        + ' piece of it there is.',
    Vocabulary: 'What things may say about themselves, and what the compiler'
        + ' makes of them.',
};

// Every panel body there is: a surface without parts is its own leaf.
export const LEAVES = TABS.flatMap((t) => t.parts?.map((p) => p.name) ?? [t.name]);

// The surface a name is reached through, and the part of it to open.
export const surfaceOf = (name) => {
    const tab = TABS.find((t) => t.name === name);
    if (tab) return { tab: name, part: tab.parts?.[0]?.name ?? null };
    const holder = TABS.find((t) => t.parts?.some((p) => p.name === name));
    return holder ? { tab: holder.name, part: name } : null;
};

// Which surface a key opens. Typing into a field must not teleport you, so the
// caller checks that first.
export const keyed = (key) => TABS.find((t) => t.key
    && t.key.toLowerCase() === key.toLowerCase())?.name ?? null;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of (ICONS[name] ?? '').split('|')) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

function button(t, onPick, kids) {
    const b = el('button', { type: 'button', className: 'tab' }, ...kids);
    b.setAttribute('aria-selected', 'false');
    b.dataset.tab = t.name;
    b.title = t.label ?? t.name;
    b.onclick = () => onPick(t.name);
    return b;
}

// You: the face, the name, and the balance. A tycoon game is played out of a
// balance, so it is on the bar and never behind a panel.
function profileButton(t, onPick) {
    const face = el('span', { className: 'face', textContent: '—' });
    const name = el('span', { className: 'name', textContent: 'Sign in' });
    const credits = el('span', { className: 'credits', textContent: '—' },
        el('i', { textContent: 'CR' }));
    const b = button(t, onPick, [
        el('span', { className: 'key', textContent: t.key }), face,
        el('span', { className: 'who' }, name, credits)]);
    b.classList.add('profile');
    return { b, face, name, credits };
}

// The bar itself. It returns the buttons by surface name so the chrome can
// select one and hang a count on it, and the profile chip's parts so signing in
// and being paid can be written into it.
export function tabBar(onPick) {
    const bar = el('div', { id: 'tabs' });
    const buttons = new Map();
    const you = profileButton(TABS.find((t) => t.name === 'Profile'), onPick);
    buttons.set('Profile', you.b);
    let first = true;
    for (const group of GROUPS) {
        const tabs = TABS.filter((t) => t.group === group);
        if (!tabs.length) continue;
        if (!first) bar.append(el('div', { className: 'rule' }));
        first = false;
        const row = el('div', { className: 'hotgroup' });
        row.dataset.group = group;
        const host = group === 'system' ? el('div', { className: 'tabs' }) : row;
        for (const t of tabs) {
            if (t.name === 'Profile') { host.append(you.b); continue; }
            const b = button(t, onPick, [
                el('span', { className: 'key', textContent: t.key }), icon(t.name),
                el('span', { className: 'label', textContent: t.label ?? t.name })]);
            if (t.small) b.classList.add('small');
            buttons.set(t.name, b);
            host.append(b);
        }
        if (group === 'system') {
            row.append(host, el('div', { className: 'names' },
                ...tabs.map((t) => el('span', { textContent: t.label ?? t.name }))));
        }
        bar.append(row);
    }
    return { bar, buttons, you };
}
