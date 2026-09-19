// tabbar.js — every surface the game has, and where it is opened from.
//
// Two places, since v6 (docs/design/chrome6.dc.html). The plinth along the
// bottom holds `bar`: the five surfaces the game is actually played through,
// on keys 1–5, and nothing else. The strip along the top holds `top`: you,
// your wallet and settings — what you are rather than what you are doing.
// Everything that used to be a small button of its own is a tab inside one of
// those three now: Share is part of Profile, and Setup and the two admin tools
// are parts of Settings.

// One drawn glyph per surface, so a surface is recognised before it is read.
// Stroked paths on a 24 box, the whole set from one hand.
export const ICONS = {
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
    Settings: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
    Share: 'M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'
        + '|M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6|m8.6 13.5 6.8 4M15.4 6.5l-6.8 4',
    Admin: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0'
        + ' 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0'
        + ' 0 1 1 1z',
    // The top strip's own two (v6): what is waiting to be read, and the apps.
    Notifications: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9|M10.3 21a1.9 1.9 0 0 0 3.4 0',
};

export const GROUPS = ['bar', 'top'];

// `parts` are the tabs inside a surface: two things that are one job — what you
// send to be rendered and what comes back for you to say yes to — belong behind
// one button, not two. Each part keeps its own name, because that is what the
// rest of the app and the stories call it.
export const TABS = [
    { name: 'World', group: null, lede: '' },
    { name: 'Place', group: 'bar', key: '1', width: 470,
        lede: 'Put a product from the catalog on your own land.' },
    { name: 'Catalog', group: 'bar', key: '2', width: 666,
        lede: 'Products anyone may build with. Register your own.' },
    { name: 'Your land', group: 'bar', key: '3', label: 'Land', width: 500,
        parts: [{ name: 'Your land', label: 'Land' },
            { name: 'Shape', label: 'Shape' }] },
    { name: 'Publish', group: 'bar', key: '4', width: 500,
        parts: [{ name: 'Submit', label: 'Submit' },
            { name: 'Permission', label: 'Approve' }] },
    // Work is a surface with queues behind it, not one list (design 8a–8f).
    // The machine strip is the surface's own head (hud.js panelHead) because
    // what this tab can do is the same answer whichever queue is open, and the
    // queues are the kinds of work the pool itself sorts into (db/0152
    // pool_open.phase), a tab each. The names are the code's and the labels
    // the design's: Publish and Settings are surfaces of their own, so no part
    // may take either word for its name.
    { name: 'Work', group: 'bar', key: '5', width: 1040,
        parts: [{ name: 'Every job', label: 'All' },
            { name: 'Render jobs', label: 'Render jobs' },
            { name: 'Training', label: 'Training' },
            { name: 'Publishing', label: 'Publish' },
            { name: 'Machine', label: 'Settings' }] },
    // A link that puts somebody where you stand is something you hand out, so
    // it belongs to you rather than to a button of its own (v6).
    { name: 'Profile', group: 'top', key: 'p', width: 470,
        parts: [{ name: 'Profile', label: 'You' },
            { name: 'Share', label: 'Share', key: '9' }] },
    { name: 'Wallet', group: 'top', key: '6', width: 500,
        lede: 'What you have, and what moved.' },
    // Settings is one panel with tabs, not three buttons: the account and the
    // ground the world stands on, and the two admin tools. Land is a map beside
    // a form and the vocabulary is two lists, so those two parts take the
    // window (`wide`) while Setup stays a column.
    { name: 'Settings', group: 'top', key: '`', width: 470,
        parts: [{ name: 'Setup', label: 'Setup' },
            { name: 'Land', label: 'Land', key: '0', wide: true },
            { name: 'Vocabulary', label: 'Vocabulary', wide: true },
            { name: 'Symbols', label: 'Symbols', wide: true },
            { name: 'Ground cover', label: 'Ground cover', wide: true }] },
];

// Every part there is, with the surface that holds it.
const PARTS = TABS.flatMap((t) => (t.parts ?? []).map((p) => ({ ...p, of: t.name })));

// What a part is for, said where the part is opened rather than on the button
// that opens the surface.
export const PART_LEDE = {
    Profile: 'Who you are in the world, and what you hold.',
    Share: 'A link that puts somebody else where you are standing.',
    Setup: 'Your account, your GeoServer, and the ground the world sits on.',
    Submit: 'Send what you placed to be rendered.',
    Permission: 'What somebody built, waiting for a person to say yes.',
    'Every job': 'What this machine can compute for the world.',
    'Render jobs': 'Draw the ground and the frames a tile asks for.',
    Training: 'Fit the splats for a tile. Long jobs; one preview each.',
    Publishing: 'The cheap end: pack a trained tile, or merge the one above it.',
    Machine: 'What this machine gives the world, and how much of it.',
    Land: 'Who is waiting for land, the ground it would be drawn on, and every'
        + ' piece of it there is.',
    Vocabulary: 'What things may say about themselves.',
    Symbols: 'What the compiler lays down where a thing is drawn.',
    'Ground cover': 'What the ground between the drawn things is made of.',
    'Your land': 'The ground you own, and what stands on it.',
    Shape: 'The ground itself: pull it up, push it down, lay a road bed.',
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

// Which surface — or which part of one — a key opens. Typing into a field must
// not teleport you, so the caller checks that first.
export const keyed = (key) => {
    const same = (t) => t.key && t.key.toLowerCase() === key.toLowerCase();
    return (TABS.find(same) ?? PARTS.find(same))?.name ?? null;
};

// Whether a leaf takes the whole window: said by the part where a surface's
// parts disagree about it, and by the surface otherwise.
export const wideAt = (name) => Boolean(PARTS.find((p) => p.name === name)?.wide
    ?? TABS.find((t) => t.name === name)?.wide);

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// One glyph, from this set or from a path handed in (the apps have their own).
export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of (ICONS[name] ?? name).split('|')) {
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

// The plinth: the five surfaces the game is played through, and nothing else.
// It returns its buttons by surface name so the chrome can select one and hang
// a count on it. Who you are and what is set once are the top strip's
// (client/js/topbar.js).
export function tabBar(onPick) {
    const bar = el('div', { id: 'tabs' });
    const buttons = new Map();
    const row = el('div', { className: 'hotgroup' });
    row.dataset.group = 'bar';
    for (const t of TABS.filter((x) => x.group === 'bar')) {
        const b = button(t, onPick, [
            el('span', { className: 'key', textContent: t.key }), icon(t.name),
            el('span', { className: 'label', textContent: t.label ?? t.name })]);
        buttons.set(t.name, b);
        row.append(b);
    }
    bar.append(row);
    return { bar, buttons };
}
