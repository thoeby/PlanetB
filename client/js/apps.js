// apps.js — the apps, and the drawer that switches between them.
//
// An app is a workspace over the same world, the way Blender's are: the bar,
// the panels and the instruments change, where you stand does not. Build is
// the one this repository implements; the others are here because the top
// strip is where they will appear, and a drawer that lists one app teaches
// nobody what the key does. Each has a hue, and the chrome takes it.
//
// Taken from docs/design/chrome6.dc.html.

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
        name: 'Drive', key: 'F2', hue: 'oklch(0.8 0.16 50)',
        desc: 'Vehicles on the real roads. Speed, gear, route, segment times.',
        icon: 'M3 15a9 9 0 0 1 18 0|M12 15l3.5-4.5|M6 15h.01|M18 15h.01|M4 20h16',
    },
    {
        name: 'Survey', key: 'F3', hue: 'oklch(0.8 0.15 145)',
        desc: 'Top-down. Parcels, ownership, rights, approvals and coverage as layers.',
        icon: 'm12 3 9 5-9 5-9-5 9-5z|M3 13l9 5 9-5|M3 17l9 5 9-5',
    },
    {
        name: 'Photo', key: 'F4', hue: 'oklch(0.78 0.13 320)',
        desc: 'Camera with real lenses. Exposure, focal length, time of day, capture.',
        icon: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    },
    {
        name: 'Render', key: 'F5', hue: 'oklch(0.82 0.16 80)',
        desc: 'Your machine as a renderer. Queue, throughput, earnings, thermals.',
        icon: 'M6 6h12v12H6z|M9 9h6v6H9z|M9 2v4M15 2v4M9 18v4M15 18v4'
            + '|M2 9h4M2 15h4M18 9h4M18 15h4',
    },
    {
        name: 'Tour', key: 'F6', hue: 'oklch(0.78 0.12 260)',
        desc: 'Guided fly-throughs and spectating. Follow a player or a saved path.',
        icon: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
            + '|M9 16h6a3 3 0 0 0 0-6h-6a3 3 0 0 1 0-6h3',
    },
];

export const appNamed = (name) => APPS.find((a) => a.name === name) ?? APPS[0];

// The key that switches an app directly, F1…F6, or null.
export const appKeyed = (code) => APPS.find((a) => a.key === code)?.name ?? null;

// One card in the drawer: the glyph, what the app is for, and whether it is
// anything yet. An app that is not wired says so on its own card rather than
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
                el('h2', { className: 'caps', textContent: 'Apps' }),
                el('p', { textContent: 'Same world, a different set of tools.'
                    + ' Panels, bar and instruments change; where you stand does not.' })),
            el('span', { className: 'how', textContent: 'F1–F6 switch · Esc close' })),
        cards);
    node.hidden = true;
    return { node, buttons };
}
