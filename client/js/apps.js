// apps.js — the views, and the drawer that switches between them.
//
// A view is a workspace over the same world, the way Blender's are: the bar,
// the panels and the instruments change, where you stand does not. Build is
// the one this repository implements; the others are here because the top
// strip is where they will appear, and a drawer that lists one view teaches
// nobody what the key does. Each has a hue, and the chrome takes it.
//
// Taken from docs/design/chrome6.dc.html, whose six apps the operator has
// since named for what they are played for (SPEC §2.1 Views): Drive, Photo
// and Tour are one view, Play; Render is Work, because what the pool pays is
// the point of it; the catalog and one's own prices are Trade & Sell; and
// Automate is the flow editor of SPEC §2.16. Survey stays as it was.

import { el, icon } from './tabbar.js';

export const APPS = [
    {
        name: 'Build', key: 'F1', hue: 'oklch(0.78 0.14 200)', live: true,
        desc: 'Place things, buy from the catalog, publish and approve. The default.',
        icon: 'm15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9|M17.6 15 22 10.6'
            + '|m20.9 11.7-1.3-1.3a3 3 0 0 1-.9-2.2v-.9L16 4.6A5.6 5.6 0 0 0 12 3H9l.9.8'
            + 'A6.2 6.2 0 0 1 12 8.4V10l2 2h2.5l2.3 1.9',
    },
    {
        name: 'Automate', key: 'F2', hue: 'oklch(0.8 0.14 290)', live: true,
        desc: 'Logic for your land: flows the process servers run.',
        icon: 'M4 5h5v4H4z|M15 3h5v4h-5z|M15 13h5v4h-5z|M9 7h3a2 2 0 0 1 2 2v6'
            + '|M9 7h6|M14 5h1|M14 15h1',
    },
    {
        name: 'Work', key: 'F3', hue: 'oklch(0.82 0.16 80)',
        desc: 'Your machine as a renderer. Queue, throughput, earnings, thermals.',
        icon: 'M6 6h12v12H6z|M9 9h6v6H9z|M9 2v4M15 2v4M9 18v4M15 18v4'
            + '|M2 9h4M2 15h4M18 9h4M18 15h4',
    },
    {
        name: 'Trade & Sell', key: 'F4', hue: 'oklch(0.78 0.13 320)',
        desc: 'The catalog both ways: what to buy, what you sell, and for how much.',
        icon: 'M3 7h11l6 6-7 7-6-6z|M7.5 10.5h.01|M14 14l2 2|M16 5h5v5',
    },
    {
        name: 'Play', key: 'F5', hue: 'oklch(0.78 0.12 260)',
        desc: 'Walk, fly, drive, visit and photograph. Follow a player or a saved path.',
        icon: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
            + '|M9 16h6a3 3 0 0 0 0-6h-6a3 3 0 0 1 0-6h3',
    },
    {
        name: 'Survey', key: 'F6', hue: 'oklch(0.8 0.15 145)',
        desc: 'Top-down. Parcels, ownership, rights, approvals and coverage as layers.',
        icon: 'm12 3 9 5-9 5-9-5 9-5z|M3 13l9 5 9-5|M3 17l9 5 9-5',
    },
];

export const appNamed = (name) => APPS.find((a) => a.name === name) ?? APPS[0];

// The key that switches an app directly, F1…F6, or null.
export const appKeyed = (code) => APPS.find((a) => a.key === code)?.name ?? null;

// One card in the drawer: the glyph, what the view is for, and whether it is
// anything yet. A view that is not wired says so on its own card rather than
// letting somebody find out by pressing it.
function card(app, onPick) {
    const b = el('button', { type: 'button', className: 'app-card' },
        el('span', { className: 'row' }, icon(app.icon),
            el('span', { className: 'key', textContent: app.key })),
        el('span', { className: 'name', textContent: app.name }),
        el('span', { className: 'desc', textContent: app.desc }),
        el('span', { className: 'status',
            textContent: app.live ? 'Installed' : 'Not wired yet' }));
    b.dataset.app = app.name;
    b.style.setProperty('--hue', app.hue);
    b.setAttribute('aria-selected', 'false');
    b.onclick = () => onPick(app.name);
    return b;
}

export function appsDrawer(onPick) {
    const cards = el('div', { className: 'cards' });
    const buttons = new Map();
    for (const a of APPS) {
        const b = card(a, onPick);
        buttons.set(a.name, b);
        cards.append(b);
    }
    const node = el('div', { id: 'apps', className: 'glass' },
        el('div', { className: 'head' },
            el('div', {},
                el('h2', { className: 'caps', textContent: 'Views' }),
                el('p', { textContent: 'Same world, a different set of tools.'
                    + ' Panels, bar and instruments change; where you stand does not.' })),
            el('span', { className: 'how', textContent: 'F1–F6 switch · Esc close' })),
        cards);
    node.hidden = true;
    return { node, buttons };
}
