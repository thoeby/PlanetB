// topbar.js — the strip along the top, one 44 px band (v6).
//
// Left: the apps button (Tab), the wordmark, and every app as a glyph — only
// the one you are in is named, in its own hue. Right: the two numbers Build is
// played by (what is rendered, what is waiting for a person), the clock, your
// balance, the bell, you, and settings. The five surfaces of the game are the
// plinth's (client/js/tabbar.js); this strip is what you are, not what you are
// doing.
//
// It decides nothing: client/js/hud.js hands it the same show() the bar uses.
//
// Taken from docs/design/chrome6.dc.html.

import { APPS } from './apps.js';
import { TABS, el, icon } from './tabbar.js';

const CLOCK_MS = 20000;

// The browser's own zone, in the short form a bar has room for.
export function zoneName(at = new Date()) {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

export const clockText = (at = new Date()) =>
    `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

const strip = (className, ...kids) => el('div', { className }, ...kids);

function tabButton(t, onPick, ...kids) {
    const b = el('button', { type: 'button', className: 'top-tab' }, ...kids);
    b.dataset.tab = t.name;
    b.title = t.label ?? t.name;
    b.setAttribute('aria-selected', 'false');
    b.onclick = () => onPick(t.name);
    return b;
}

// You, in the width of a bar: the face, the name, and a pip that is lit when
// somebody is signed in at all.
function profileChip(onPick) {
    const face = el('span', { className: 'face', textContent: '—' });
    const name = el('span', { className: 'name', textContent: 'Sign in' });
    const b = tabButton(TABS.find((t) => t.name === 'Profile'), onPick, face, name);
    b.classList.add('who');
    return { b, face, name };
}

// What is in the wallet, on the bar, because a tycoon game is played out of a
// balance and it should never need opening to be read.
function walletChip(onPick) {
    const credits = el('span', { className: 'credits', textContent: '—' },
        el('i', { textContent: 'CR' }));
    const b = tabButton(TABS.find((t) => t.name === 'Wallet'), onPick,
        icon('Wallet'), credits);
    b.classList.add('money');
    return { b, credits };
}

function numbers() {
    const cells = {};
    const node = strip('top-stats');
    for (const [key, label, tone] of [['rendered', 'rendered', 'accent'],
        ['awaiting', 'to decide', 'warn']]) {
        const value = el('b', { textContent: '0' });
        const cell = el('div', { className: 'num' }, value,
            el('span', { className: 'caps', textContent: label }));
        cell.dataset.tone = tone;
        cell.dataset.stat = key;
        cells[key] = value;
        node.append(cell);
    }
    return { node, cells };
}

// The views, as glyphs. Only the one you are in carries its name and its key,
// so six views cost the width of one plus five icons.
function appTabs(onApp) {
    const buttons = new Map();
    const node = strip('top-apps');
    for (const a of APPS) {
        const b = el('button', { type: 'button', className: 'app-tab' },
            icon(a.icon), el('span', { className: 'name', textContent: a.name }),
            el('span', { className: 'key mono', textContent: a.key }));
        b.dataset.app = a.name;
        b.title = `${a.name} · ${a.key}`;
        b.style.setProperty('--hue', a.hue);
        b.setAttribute('aria-selected', 'false');
        b.onclick = () => onApp(a.name);
        buttons.set(a.name, b);
        node.append(b);
    }
    return { node, buttons };
}

// What this machine is computing for the world, where a thing that is
// happening belongs: beside the bell, lit while the tab is busy and gone when
// it is idle. Pressing it opens the queue it is working out of. The panel used
// to carry this as a strip over its own cards (design 8a); a state that is
// true of the whole page does not belong inside one panel.
function machineChip(show) {
    const what = el('span', { className: 'what' });
    const b = el('button', { type: 'button', id: 'machine',
        title: 'What this machine is computing' }, el('i', { className: 'pip' }), what);
    b.hidden = true;
    b.onclick = () => show('Every job');
    return { b, what };
}

export function topBar(show, { onApps, onTray }) {
    const buttons = new Map();
    const apps = appTabs((name) => onApps(name));
    const appsBtn = el('button', { type: 'button', id: 'apps-btn', title: 'Views' },
        el('span', { className: 'grid' }, ...Array.from({ length: 9 }, () => el('i'))),
        el('span', { className: 'hint mono', textContent: 'Tab' }));
    appsBtn.setAttribute('aria-selected', 'false');
    appsBtn.onclick = () => onApps(null);

    const stats = numbers();
    const clock = el('div', { className: 'clock' },
        el('b', { className: 'mono', textContent: clockText() }),
        el('span', { className: 'caps', textContent: zoneName() }));
    const bell = el('button', { type: 'button', id: 'bell', title: 'Notifications' },
        icon('Notifications'), el('span', { className: 'count', hidden: true }));
    bell.setAttribute('aria-selected', 'false');
    bell.onclick = () => onTray();
    const you = profileChip(show);
    const money = walletChip(show);
    const settings = tabButton(TABS.find((t) => t.name === 'Settings'), show,
        icon('Settings'));
    buttons.set('Profile', you.b);
    buttons.set('Wallet', money.b);
    buttons.set('Settings', settings);
    // SPEC §2.1: how many things are waiting for you, beside the bell that
    // says what they were. js/attention.js fills it.
    const waiting = el('div', { id: 'waiting' });

    const machine = machineChip(show);
    const node = el('div', { id: 'top' },
        strip('top-left', appsBtn,
            el('span', { className: 'mark', textContent: 'splatworld' }), apps.node),
        strip('top-right', machine.b, waiting, stats.node, clock, money.b, bell,
            you.b, settings));
    setInterval(() => {
        clock.firstChild.textContent = clockText();
    }, CLOCK_MS);
    return { node, buttons, you, money, stats: stats.cells, apps: apps.buttons,
        appsBtn, bell, waiting, machine };
}
