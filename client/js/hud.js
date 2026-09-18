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

import { GROUPS, LEAVES, PART_LEDE, TABS, keyed, surfaceOf, tabBar, wideAt }
    from './tabbar.js';
import { mountAltimeter } from './altimeter.js';
import { drawHints, el, keyHints, place, topCentre } from './chrome.js';
import { APPS, appKeyed, appNamed, appsDrawer } from './apps.js';
import { mountNotify } from './notify.js';
import { topBar } from './topbar.js';

export { GROUPS, TABS, keyed };
export { APPS };

// An empty world is black, and black says nothing. What is missing is always
// one of four things, and each of them is somebody's next move.
export function whatIsMissing({ coverage, areas = 0, mine = 0, things = null,
    published = 0 } = {}) {
    if (!coverage) {
        return 'No ground yet. Setup \u00b7 connect your GeoServer and pick the'
            + ' coverage the world stands on.';
    }
    if (!areas) {
        return 'No land yet. Draw an area in QGIS — run `splatworld qgis`, open'
            + ' gis/splatworld.qgs, draw on Your land and save.';
    }
    // Land on its own holds nothing to compile: a tile exists where something
    // stands. This is the step people fall down, because the land is drawn and
    // the world still says nothing is waiting.
    if (things === 0) {
        return 'Nothing stands on your land yet. In QGIS, draw a road, a wood or'
            + ' a building inside it and save — that is what there is to compile.';
    }
    if (!published) {
        return mine
            ? 'Nothing here is compiled yet. Submit \u00b7 put your land in the'
              + ' render pool, then render it and approve what comes back.'
            : 'Nothing here is compiled yet, and none of the land is yours.';
    }
    return '';
}

// Two letters off a name or an address, for the face on the bar.
const initials = (label) => {
    const word = String(label ?? '').split('@')[0];
    const parts = word.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const two = parts.length > 1 ? parts[0][0] + parts[1][0] : word.slice(0, 2);
    return (two || '\u2014').toUpperCase();
};



// The panel frame: a title, whatever this surface says about itself above its
// parts, the parts where it has more than one, and the × that closes it.
function panelFrame(onClose, onPart) {
    const title = el('span', { className: 'title' });
    const close = el('button', { type: 'button', className: 'close',
        textContent: '×', title: 'close' });
    close.onclick = onClose;
    // One host per surface, between the title and the parts: what is true of
    // every part of a surface belongs above the tabs rather than repeated
    // inside each of them. Work's machine strip is the case — what this tab
    // can do and what it is doing is the same answer whichever queue you are
    // looking at.
    const heads = new Map();
    const head = el('div', { className: 'head' });
    for (const t of TABS) {
        const host = el('div', { className: 'tab-head' });
        host.hidden = true;
        heads.set(t.name, host);
        head.append(host);
    }
    const parts = el('nav', { className: 'parts' });
    const partButtons = new Map();
    for (const t of TABS) {
        for (const part of t.parts ?? []) {
            const b = el('button', { type: 'button', className: 'part',
                textContent: part.label });
            b.dataset.tab = part.name;
            b.dataset.of = t.name;
            b.setAttribute('aria-selected', 'false');
            b.onclick = () => onPart(part.name);
            partButtons.set(part.name, b);
            parts.append(b);
        }
    }
    const body = el('div', { className: 'body' });
    const node = el('aside', { id: 'panel', className: 'glass' },
        el('header', {}, title, close), head, parts, body);
    return { node, title, body, head, heads, parts, partButtons };
}

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
    for (const t of TABS) {
        if (t.parts) {
            buttons.get(t.name).dataset.parts = `,${t.parts.map((x) => x.name).join(',')},`;
        }
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
    const hud = el('div', { id: 'hud' },
        labels, strip.node, drawer.node, notify.tray, notify.toasts,
        top.node, frame.node, bar,
        el('div', { id: 'corner' },
            hints,
            el('div', { id: 'map', className: 'glass' }, map, scale, mapBox)),
        el('div', { id: 'legend', className: 'glass' },
            el('span', { className: 'published' }, el('i'), 'Published'),
            el('span', { className: 'candidate' }, el('i'),
                'Candidate \u00b7 awaiting approval'),
            el('span', { className: 'mine' }, el('i'), 'Yours \u00b7 not yet submitted'),
            el('span', { className: 'theirs' }, el('i'), 'No build rights')),
        el('div', { id: 'crosshair' }, el('i'), el('i'), el('i'), el('i')),
        notice);

    doc.body.append(el('div', { id: 'vignette' }), hud);
    const alt = mountAltimeter(hud);
    return { hud, top, strip, drawer, notify, you: strip.you, stats: strip.stats,
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
    f.hud.style.setProperty('--accent', app.hue);
    f.hud.style.setProperty('--accent-dim', `color-mix(in oklab, ${app.hue} 14%, transparent)`);
    for (const [n, b] of f.strip.apps) b.setAttribute('aria-selected', String(n === app.name));
    for (const [n, b] of f.drawer.buttons) b.setAttribute('aria-selected', String(n === app.name));
    return app.name;
}

// Which panel is on screen, and the frame dressed for it. `name` is a leaf —
// a surface, or one part of one — and the bar lights the surface it is under.
function showPanel(name, { buttons, bodies, frame }) {
    const at = surfaceOf(name) ?? { tab: 'World', part: null };
    for (const [tab, b] of buttons) b.setAttribute('aria-selected', String(tab === at.tab));
    const leaf = at.part ?? at.tab;
    for (const [tab, host] of bodies) host.hidden = tab !== leaf;
    for (const [part, b] of frame.partButtons) {
        b.hidden = b.dataset.of !== at.tab;
        b.setAttribute('aria-selected', String(part === leaf));
    }
    const tab = TABS.find((t) => t.name === at.tab);
    frame.parts.hidden = !tab?.parts;
    for (const [name, host] of frame.heads) host.hidden = name !== at.tab;
    frame.head.hidden = !frame.heads.get(at.tab)?.childElementCount;
    frame.title.textContent = at.tab;
    frame.node.dataset.open = at.tab === 'World' ? '' : '1';
    // Each panel is as wide as what it has to show (TABS.width), and a leaf
    // marked `wide` takes the window: a tool that is a map beside a form has
    // nothing to gain from being a column. Settings holds both kinds, so the
    // part decides where it has an opinion (tabbar.js wideAt).
    const wide = wideAt(leaf);
    frame.node.dataset.wide = wide ? '1' : '';
    frame.node.style.width = !wide && tab?.width ? `${tab.width}px` : '';
}


// What the bar and the corners say about you and about the world's progress.
function state(f) {
    const { you, stats, buttons, notice } = f;
    const credits = f.strip.money.credits;
    return {
        // A surface with something waiting behind it says so without being
        // opened. A count hung on a part shows on the surface that holds it.
        badge(name, n) {
            const b = buttons.get(surfaceOf(name)?.tab ?? name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n > 0) b.append(el('span', { className: 'count', textContent: String(n) }));
        },
        // How many jobs are behind one part of a surface, on the part's own
        // tab (design 8a: every queue carries its count). A null takes it off;
        // zero is a number worth showing, because an empty queue is an answer.
        partCount(name, n) {
            const b = f.frame.partButtons.get(name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n !== null && n !== undefined) {
                b.append(el('span', { className: 'count', textContent: String(n) }));
            }
        },
        // Who you are, on the chip that is you: initials on the face, the name
        // beside it, and a lit pip when somebody is signed in at all.
        signedIn(label) {
            const name = label && label !== 'not signed in' ? label : '';
            // The chip is 9rem wide: an address is shown by the part of it
            // that is a person, with the whole of it on the button's title.
            you.name.textContent = name ? name.split('@')[0] : 'Sign in';
            you.face.textContent = initials(name);
            you.b.dataset.in = name ? '1' : '';
            you.b.title = name || 'Profile';
        },
        // The one line an empty world needs: what is missing, and where to do
        // something about it. Empty text takes it away.
        notice(text) {
            notice.textContent = text ?? '';
            notice.hidden = !text;
        },
        // v6 keeps two of the five stages on the bar — what is rendered and
        // what is waiting for a person — and the balance beside them. The rest
        // are read in the panel that is about them; a number nobody acts on is
        // not worth a strip along the top.
        stat(key, value) {
            if (key === 'credits') {
                credits.replaceChildren(value ?? '\u2014', el('i', { textContent: 'CR' }));
            } else if (stats[key]) stats[key].textContent = value;
        },
        // How high you are, how far that is above the ground, and where you
        // are looking (client/js/altimeter.js).
        height(at) { f.alt.set(at); },
        // Walking or flying, and the keys for it (SPEC §2.3's corner).
        moving(mode) { drawHints(f.hints, mode); },
        // The minimap, the scale it is drawn at, and where its search lives.
        minimap: () => f.map,
        mapBox: () => f.mapBox,
        mapScale(text) { f.scale.textContent = text; },
        // Where the attention chip is mounted (SPEC §2.1).
        waitingSlot: () => f.waiting,
    };
}

// The drawer and the tray are the two things that hang off the top strip, and
// only one of them is ever down.
function drawersOf(at) {
    const d = {
        apps(yes) {
            at().drawer.node.hidden = !yes;
            at().strip.appsBtn.setAttribute('aria-selected', String(yes));
            if (yes) d.tray(false);
        },
        tray(yes) {
            at().notify.open(yes);
            at().strip.bell.setAttribute('aria-selected', String(yes));
            if (yes) {
                at().drawer.node.hidden = true;
                at().strip.appsBtn.setAttribute('aria-selected', 'false');
            }
        },
        toggleTray() { d.tray(!at().notify.isOpen()); },
        close() {
            const was = !at().drawer.node.hidden || at().notify.isOpen();
            d.apps(false);
            d.tray(false);
            return was;
        },
    };
    return d;
}

export function mountHud(doc) {
    let open = 'World';
    let app = 'Build';
    const drawers = drawersOf(() => f);
    const pickApp = (name) => {
        if (name === null) { drawers.apps(f.drawer.node.hidden); return app; }
        app = dressFor(f, name);
        drawers.apps(false);
        if (app !== 'Build') show('World');
        return app;
    };
    const f = buildFrame(doc, (name) => show(name), {
        onApps: pickApp, onTray: () => drawers.tray(!f.notify.isOpen()),
        pick: pickApp,
    });
    f.notify.onCount((n) => {
        const count = f.strip.bell.querySelector('.count');
        count.hidden = n === 0;
        count.textContent = String(n);
    });
    dressFor(f, app);
    // What a panel wants done when it is opened. A queue somebody else is
    // working out of is out of date the moment it is drawn, and opening the
    // surface is the player asking what is in it.
    const onShow = new Map();

    function show(name) {
        if (name === open && name !== 'World') name = 'World';
        open = name;
        showPanel(name, f);
        // The hook belongs to the body that is now on screen, not to the word
        // that was clicked. Opening a surface from the bar opens its first
        // part, and it was that part's queue that went stale while it was
        // closed — Submit's refresh never ran when Publish was opened from
        // the bar, only when its own tab was pressed.
        const at = surfaceOf(name);
        onShow.get(name)?.();
        const leaf = at?.part;
        if (leaf && leaf !== name) onShow.get(leaf)?.();
        return f.bodies.get(leaf ?? name);
    }

    bindKeys(doc, { show, apps: pickApp, drawer: () => pickApp(null),
        tray: () => drawers.tray(!f.notify.isOpen()), close: drawers.close });
    // The world is what the page opens on: every panel hidden, nothing docked.
    // Said once here rather than left to the markup, so the frame's state and
    // `open` cannot start out disagreeing.
    show(open);

    return {
        show,
        // What happened while you were looking somewhere else: under the bell
        // for eight seconds, and in the tray after that (client/js/notify.js).
        notify: (n) => f.notify.push(n),
        // Which workspace the chrome is dressed for, and switching it.
        app: (name) => (name === undefined ? app : pickApp(name)),
        panel: (name) => f.bodies.get(name),
        // What a surface says above its parts, rather than inside one of them.
        panelHead: (name) => f.frame.heads.get(name),
        whenShown(name, fn) { onShow.set(name, fn); },
        opened: () => open,
        ...state(f),
        ...place(f.top),
    };
}
