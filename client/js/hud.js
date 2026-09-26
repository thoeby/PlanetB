// hud.js — the chrome around the world: where you are, what you own, and one
// visible control for everything the tool can do.
//
// It holds no policy and no data. It builds the frame, owns which surface is
// open, and hands each one a body element for whichever module fills it. A
// module mounted here neither knows nor cares that it is in a tab.
//
// The strip along the top is client/js/topbar.js and the plinth along the
// bottom client/js/tabbar.js; the altimeter up the right is
// client/js/altimeter.js and the compass, place line and key hints are
// client/js/chrome.js. This puts them on the screen.

import { GROUPS, LEAVES, PART_LEDE, TABS, keyed, surfaceOf, tabBar, viewOf, wideAt }
    from './tabbar.js';
import { mountAltimeter } from './altimeter.js';
import { el, keyHints, place, topCentre } from './chrome.js';
import { APPS, appIsFull, appKeyed, appNamed, appSurface, appsDrawer } from './apps.js';
import { mountNotify } from './notify.js';
import { state, whatIsMissing } from './hudsays.js';
import { topBar } from './topbar.js';
import { centreSlot, editSlot, fitBar, watchFit } from './hudbar.js';
import { drawersOf, panelFrame, windowWatch } from './hudframe.js';

export { GROUPS, TABS, keyed };
export { APPS };
export { whatIsMissing };

// Everything that is on screen, built once. `show` is passed in because the
// bar's buttons need it before mountHud has defined it.
function buildFrame(doc, show, on) {
    const top = topCentre();
    const frame = panelFrame(() => show('World'), show);
    const { bar, buttons } = tabBar(show);
    const strip = topBar(show, on);
    const notify = mountNotify();
    const drawer = appsDrawer(on.pick);
    for (const [name, b] of strip.buttons) buttons.set(name, b);
    // The stories and the tests reach a part by name; the button that opens it
    // is the surface's, so the surface says which parts are behind it. Comma
    // delimited and comma terminated, because a part's name is words — "Render
    // jobs" — and a space-separated list cannot hold one: a selector matches
    // ",Render jobs," and gets exactly the surface that holds it.
    // A surface that is a whole view has no button on either bar — Survey is
    // reached by switching to it — so there is nothing to hang its parts on.
    for (const t of TABS) {
        const b = t.parts && buttons.get(t.name);
        if (b) b.dataset.parts = `,${t.parts.map((x) => x.name).join(',')},`;
    }
    const map = el('canvas', { id: 'minimap', width: 240, height: 240 });
    // Where the map's search box goes (client/js/places.js): the map is the
    // corner one, so what it finds is a short list under it.
    const mapBox = el('div', { id: 'map-search' });
    const scale = el('span', { className: 'scale', textContent: 'Map · M' });

    // Each surface gets its body once and keeps it, so a module mounted into it
    // survives the panel being closed and opened again. The lede is written
    // here rather than by each module, so a panel nobody has built yet still
    // says what it will be for.
    const bodies = new Map();
    for (const name of LEAVES) {
        const host = el('div', { className: 'tab-body' });
        host.hidden = true;
        const lede = TABS.find((t) => t.name === name)?.lede ?? PART_LEDE[name];
        if (lede) host.append(el('p', { className: 'lede', textContent: lede }));
        bodies.set(name, host);
        frame.body.append(host);
    }

    const notice = el('div', { id: 'notice', className: 'glass' });
    notice.hidden = true;
    const hints = keyHints();
    // SPEC §3.2: a land's name is drawn on the ground, and letters are HTML.
    const labels = el('div', { id: 'world-labels' });
    // UI.1: the compass and the place line are the middle of the top bar.
    const slot = centreSlot(strip.centre, top.node);
    const edits = editSlot(strip.edit);
    const hud = el('div', { id: 'hud' },
        labels, strip.node, drawer.node, notify.tray, notify.toasts,
        frame.node, bar,
        el('div', { id: 'corner' },
            hints,
            el('div', { id: 'map', className: 'glass' }, map, scale, mapBox)),
        el('div', { id: 'crosshair' }, el('i'), el('i'), el('i'), el('i')),
        notice);

    doc.body.append(el('div', { id: 'vignette' }), hud);
    // UI.2: the altimeter is part of the map in the corner.
    const alt = mountAltimeter(hud.querySelector('#map'));
    return { hud, top, strip, drawer, notify, you: strip.you, stats: strip.stats,
        slot, edits,
        frame, buttons, bodies, notice, map, mapBox, scale,
        waiting: strip.waiting, hints, alt };
}

// A key opens its surface, Tab the apps drawer, F1–F6 an app; Escape closes
// whatever is open, nearest first. None of it fires while somebody is typing —
// a land called "5" has to be nameable.
function bindKeys(doc, { show, apps, drawer, tray, close }) {
    doc.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        if (e.code === 'Tab') { e.preventDefault(); drawer(); return; }
        if (e.key === 'Escape') {
            if (!close()) show('World');
            return;
        }
        const app = appKeyed(e.code);
        if (app) { e.preventDefault(); apps(app); return; }
        if (e.code === 'KeyN') { e.preventDefault(); tray(); return; }
        const name = keyed(e.key);
        if (!name) return;
        e.preventDefault();
        show(name);
    });
}

// Switching app switches the chrome, not where you stand: the hue everything
// accented takes, and Build's own instruments and surfaces, which the other
// five apps have nothing to put in yet.
function dressFor(f, name) {
    const app = appNamed(name);
    f.hud.dataset.app = app.name;
    // A workspace takes the window: no plinth under it and no instruments
    // around it (client/js/apps.js appIsFull, client/frame.css).
    f.hud.dataset.full = app.full ? '1' : '';
    f.hud.style.setProperty('--accent', app.hue);
    f.hud.style.setProperty('--accent-dim', `color-mix(in oklab, ${app.hue} 14%, transparent)`);
    // The plinth is this view's surfaces and nobody else's: a bar about the
    // land you are standing on has no business under a window of the pool.
    // A view with none of its own has no plinth at all rather than an empty
    // one — Play is the world with nothing on it yet, and an empty chamfered
    // box standing on the bottom edge is not a thing that says so.
    let on = 0;
    for (const [, b] of f.buttons) {
        if (b.dataset.view === undefined) continue;
        b.hidden = b.dataset.view !== app.name;
        if (!b.hidden) on += 1;
    }
    f.hud.dataset.plinth = on ? '1' : '';
    for (const [n, b] of f.strip.apps) b.setAttribute('aria-selected', String(n === app.name));
    for (const [n, b] of f.drawer.buttons) b.setAttribute('aria-selected', String(n === app.name));
    return app.name;
}

// Which panel is on screen, and the frame dressed for it. `name` is a leaf —
// a surface, or one part of one — and the bar lights the surface it is under.
function showPanel(name, f) {
    const { buttons, bodies, frame } = f;
    const at = surfaceOf(name) ?? { tab: 'World', part: null };
    for (const [tab, b] of buttons) b.setAttribute('aria-selected', String(tab === at.tab));
    const leaf = at.part ?? at.tab;
    for (const [tab, host] of bodies) host.hidden = tab !== leaf;
    for (const [part, b] of frame.partButtons) {
        b.hidden = b.dataset.of !== at.tab;
        b.setAttribute('aria-selected', String(part === leaf));
    }
    const tab = TABS.find((t) => t.name === at.tab);
    // One part is not a choice: a strip of tabs with one word on it says a
    // surface has others when it has not.
    frame.parts.hidden = (tab?.parts?.length ?? 0) < 2;
    for (const [name, host] of frame.heads) host.hidden = name !== at.tab;
    frame.head.hidden = !frame.heads.get(at.tab)?.childElementCount;
    frame.title.textContent = at.tab;
    frame.node.dataset.open = at.tab === 'World' ? '' : '1';
    // Which surface is on screen, for the one or two that need a rule of their
    // own: a wide panel lays its body out in columns of modules, and Work's
    // body is one queue whose cards are already a grid (client/work.css).
    frame.node.dataset.surface = at.tab;
    frame.node.dataset.part = leaf;
    // Each panel is as wide as what it has to show (TABS.width), and a leaf
    // marked `wide` takes the window: a tool that is a map beside a form has
    // nothing to gain from being a column. Settings holds both kinds, so the
    // part decides where it has an opinion (tabbar.js wideAt).
    // A workspace's own surface takes the window whatever the surface says
    // about itself: the catalog is a 666 px drawer on Build's plinth and the
    // whole of Trade & Sell, and it is one surface either way.
    const app = f.hud.dataset.app;
    // A workspace has the window when the surface it exists to open is the one
    // on screen. Then there is nothing behind the panel to look at, so the
    // world is not drawn at all and the glass is not glass (client/frame.css,
    // client/js/playapps.js). Automate is full too and has no surface of its own:
    // it is its own window (client/flow) and puts the world away itself.
    const takes = appIsFull(app) && appSurface(app) !== null
        && appSurface(app) === at.tab;
    f.hud.dataset.window = takes ? '1' : '';
    const wide = wideAt(leaf) || takes;
    frame.node.dataset.wide = wide ? '1' : '';
    // A panel that reaches both gutters has the corner instruments over it —
    // the altimeter up the right-hand edge and the controls and map above the
    // bottom one — so they go while it is open, wherever it was opened from.
    // A view that takes the window puts them away for good (apps.js `full`).
    f.hud.dataset.covered = wide && at.tab !== 'World' ? '1' : '';
    frame.node.style.width = !wide && tab?.width ? `${tab.width}px` : '';
    barFor(f, takes && !frame.parts.hidden);
}

// UI.1: a workspace that has the window shows its tabs in the top bar and has
// no title of its own — the view's glyph already says what it is. Anywhere
// else the tabs stay under the panel's title and the bar says where you are.
function barFor(f, tabsUp) {
    const { frame } = f;
    if (!tabsUp && frame.parts.parentNode !== frame.node) {
        frame.node.insertBefore(frame.parts, frame.body);
    }
    f.slot.show({ parts: tabsUp ? frame.parts : null,
        world: !appIsFull(f.hud.dataset.app) });
    fitBar(f.strip.node);
    f.edits.changed();
}


// How many notifications are waiting, on the bell.
function countOnTheBell(f) {
    f.notify.onCount((n) => {
        const count = f.strip.bell.querySelector('.count');
        count.hidden = n === 0;
        count.textContent = String(n);
    });
}

export function mountHud(doc) {
    let open = 'World';
    let app = 'Build';
    const drawers = drawersOf(() => f);
    // A view that is a workspace of its own — Automate is the first — is told
    // when it is switched to and away from; the chrome itself only changes hue.
    // And Blueprint, which a surface opens and has to close again when
    // anything else is opened, is told every panel that is.
    const [watching, taking, onOpened] = [[], [], []];
    // Switching a view dresses the chrome for it and tells whoever is
    // watching. `open` is left alone: pickApp decides what to open, and
    // `show` calls this when a panel belongs to another view.
    const dressOnly = (name) => {
        const was = app;
        app = dressFor(f, name);
        drawers.apps(false);
        if (app !== was) for (const fn of watching) fn(app, was);
        return app;
    };
    const pickApp = (name) => {
        if (name === null) { drawers.apps(f.drawer.node.hidden); return app; }
        dressOnly(name);
        // A view opens what it is (apps.js appSurface). A view that is the
        // world closes whatever the last one had open: a panel belonging to
        // another workspace left over the world is not this one.
        show(appSurface(app) ?? 'World');
        return app;
    };
    const f = buildFrame(doc, (name) => show(name), {
        onApps: pickApp, onTray: () => drawers.tray(!f.notify.isOpen()),
        pick: pickApp,
    });
    countOnTheBell(f);
    dressFor(f, app);
    watchFit(f.strip.node);
    // What a panel wants done when it is opened. A queue somebody else is
    // working out of is out of date the moment it is drawn, and opening the
    // surface is the player asking what is in it.
    const onShow = new Map();
    const took = windowWatch(f, taking);

    function show(name) {
        if (name === open && name !== 'World') name = 'World';
        // A view whose panel is closed is a hue over the world and nothing
        // else, so closing it leaves the view: Esc and the × go back to Build.
        if (name === 'World' && open !== 'World' && appSurface(app)) {
            open = name;
            pickApp('Build');
            for (const fn of onOpened) fn(name);
            return f.bodies.get(name);
        }
        open = name;
        // And the chrome is dressed for whichever view this panel belongs to.
        // The plinth is not Build's alone any more — Work is the fifth button
        // on it and the F3 view, and the catalog is Trade & Sell — so opening
        // one from the bar walks into that workspace rather than leaving the
        // last one's hue over somebody else's panel.
        // A surface that belongs to no one view — Profile, the wallet,
        // Settings — is the same wherever you are working and leaves the view
        // alone. Nor does a view get walked out of by opening the surface it
        // exists to open: the catalog is on Build's plinth and it is the whole
        // of Trade & Sell, and pressing F4 must not land you back in Build.
        const at2 = surfaceOf(name);
        const belongs = name === 'World' ? null : viewOf(name);
        if (belongs && appSurface(app) !== at2?.tab) dressOnly(belongs);
        showPanel(name, f);
        // The hook belongs to the body that is now on screen, not to the word
        // that was clicked. Opening a surface from the bar opens its first
        // part, and it was that part's queue that went stale while it was
        // closed — Submit's refresh never ran when Publish was opened from
        // the bar, only when its own tab was pressed.
        const at = surfaceOf(name);
        took();
        onShow.get(name)?.();
        const leaf = at?.part;
        if (leaf && leaf !== name) onShow.get(leaf)?.();
        for (const fn of onOpened) fn(leaf ?? name);
        return f.bodies.get(leaf ?? name);
    }

    bindKeys(doc, { show, apps: pickApp, drawer: () => pickApp(null),
        tray: () => drawers.tray(!f.notify.isOpen()), close: drawers.close });
    // The world is what the page opens on: every panel hidden, nothing docked.
    // Said once here rather than left to the markup, so the frame's state and
    // `open` cannot start out disagreeing.
    show(open);

    return handle(f, { show, pickApp, onShow, app: () => app, opened: () => open,
        watching, taking, onOpened });
}

// What the rest of the page holds the chrome by.
function handle(f, { show, pickApp, onShow, app, opened, watching, taking, onOpened }) {
    return {
        show,
        // What happened while you were looking somewhere else: under the bell
        // for eight seconds, and in the tray after that (client/js/notify.js).
        notify: (n) => f.notify.push(n),
        // Which workspace the chrome is dressed for, and switching it.
        app: (name) => (name === undefined ? app() : pickApp(name)),
        onApp(fn) { watching.push(fn); },
        // Whether a workspace has the window, and being told when that changes.
        onWindow(fn) { taking.push(fn); },
        takesWindow: () => f.hud.dataset.window === '1',
        panel: (name) => f.bodies.get(name),
        // What a surface says above its parts, rather than inside one of them.
        panelHead: (name) => f.frame.heads.get(name),
        // UI.1: undo and redo on the bar for whoever is editing, and the
        // middle of the bar lent to a workspace's own tabs (Automate).
        edits: f.edits,
        barTabs(node) {
            f.slot.lend(node);
            barFor(f, f.hud.dataset.window === '1' && !f.frame.parts.hidden);
        },
        whenShown(name, fn) { onShow.set(name, fn); },
        // Every panel opened, by the name of the body now on screen.
        whenOpened(fn) { onOpened.push(fn); },
        opened,
        ...state(f),
        ...place(f.top),
    };
}
