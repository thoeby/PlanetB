// hud.js — the chrome around the world: where you are, what you own, and one
// visible control for everything the tool can do.
//
// It holds no policy and no data. It builds the frame, owns which surface is
// open, and hands each one a body element for whichever module fills it. A
// module mounted here neither knows nor cares that it is in a tab.
//
// The bar along the bottom is client/js/tabbar.js and the altimeter up the
// right is client/js/altimeter.js; this puts them on the screen.

import { GROUPS, LEAVES, PART_LEDE, TABS, keyed, surfaceOf, tabBar }
    from './tabbar.js';
import { mountAltimeter } from './altimeter.js';

export { GROUPS, TABS, keyed };

// The five stages of the route through the app, in order, as the chrome shows
// them. Credits are not a stage: they sit in their own chip beside these.
export const STAGES = [
    { key: 'placed', label: 'Placed' },
    { key: 'pool', label: 'In pool' },
    { key: 'rendered', label: 'Rendered', tone: 'accent' },
    { key: 'awaiting', label: 'Awaiting', tone: 'warn' },
    { key: 'published', label: 'Published', tone: 'accent' },
];

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// A strip of headings that slides under a fixed needle: the point under the
// needle is the way the camera is facing.
function compass() {
    const node = el('div', { id: 'compass', className: 'glass' });
    const marks = [];
    for (let i = 0; i < 24; i++) {
        const deg = i * 15;
        const name = deg % 45 === 0 ? POINTS[(deg / 45) % 8] : '';
        const span = el('span', { textContent: name });
        if (name) span.dataset.cardinal = '1';
        span.dataset.deg = String(deg);
        marks.push(span);
        node.append(span);
    }
    node.append(el('span', { className: 'needle' }));
    // Which heading sits where, relative to the needle: ±90° across the strip.
    const face = (heading) => {
        for (const m of marks) {
            let d = Number(m.dataset.deg) - heading;
            d = ((d + 540) % 360) - 180;
            // A mark at the very edge is cut in half by the strip's own clip,
            // which reads as a typo rather than as a compass.
            m.style.display = Math.abs(d) > 80 ? 'none' : '';
            m.style.left = `${50 + (d / 92) * 50}%`;
        }
    };
    face(0);
    return { node, face };
}

function topCentre() {
    const c = compass();
    const land = el('div', { id: 'land', textContent: 'nowhere yet' });
    const owner = el('span', { className: 'owner' });
    const right = el('span', { className: 'right', textContent: 'read only' });
    const coords = el('span', { className: 'coords', textContent: '—' });
    const standing = el('div', { id: 'standing' },
        owner, el('span', { className: 'dot' }), right,
        el('span', { className: 'dot' }), coords);
    return { node: el('div', { id: 'where' }, c.node, land, standing),
        face: c.face, land, owner, right, coords };
}

// Which way you are moving, and the keys that go with it. Walking and flying
// are different controls — Shift runs on the ground and goes down in the air,
// and forward follows where you are looking only in the air — so the corner
// says which of the two you are in rather than listing both and leaving it to
// be discovered. A key hint is not decoration: it is the only way to learn
// that the keys work at all.
const MOVE = {
    walk: { name: 'Walking', keys: [['Move', 'W A S D'], ['Look', 'drag'],
        ['Run', 'Shift'], ['Fly', 'F']] },
    fly: { name: 'Flying', keys: [['Fly where you look', 'W A S D'],
        ['Look', 'drag'], ['Up', 'Space'], ['Down', 'Shift'], ['Walk', 'F']] },
};

function keyHints() {
    const node = el('div', { id: 'hints', className: 'glass' });
    drawHints(node, 'walk');
    return node;
}

function drawHints(node, mode) {
    const how = MOVE[mode] ?? MOVE.walk;
    node.dataset.mode = mode;
    node.replaceChildren(
        el('span', { className: 'mode' },
            el('i', { className: 'pip' }),
            el('b', { className: 'mode-name', textContent: how.name })),
        ...how.keys.map(([what, key]) =>
            el('span', {}, el('b', { textContent: what }), ` ${key}`)),
        el('span', {}, el('b', { textContent: 'Close panel' }), ' Esc'));
}

// The route through the app, always visible: how many things you have placed,
// how many tiles are in the pool, how many of those a renderer holds, how many
// are waiting for a person, how many are published. Credits are not a stage —
// they are on the bar, in the chip that is you.
function pipeline() {
    const strip = el('div', { id: 'pipeline', className: 'glass' });
    const cells = {};
    for (const st of STAGES) {
        const value = el('span', { className: 'value', textContent: '0' });
        const cell = el('div', { className: 'stage' },
            el('span', { className: 'label', textContent: st.label }), value,
            el('i', {}));
        if (st.tone) cell.dataset.tone = st.tone;
        cell.dataset.stat = st.key;
        cells[st.key] = value;
        strip.append(cell);
    }
    return { node: el('div', { id: 'stats' }, strip), cells };
}

// The panel frame: a title, the parts of this surface where it has more than
// one, and the × that closes it.
function panelFrame(onClose, onPart) {
    const title = el('span', { className: 'title' });
    const close = el('button', { type: 'button', className: 'close',
        textContent: '×', title: 'close' });
    close.onclick = onClose;
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
        el('header', {}, title, close), parts, body);
    return { node, title, body, parts, partButtons };
}

// Everything that is on screen, built once. `show` is passed in because the
// bar's buttons need it before mountHud has defined it.
function buildFrame(doc, show) {
    const top = topCentre();
    const pipe = pipeline();
    const frame = panelFrame(() => show('World'), show);
    const { bar, buttons, you } = tabBar(show);
    // The stories and the tests reach a part by name; the button that opens it
    // is the surface's, so the surface says which parts are behind it.
    for (const t of TABS) {
        if (t.parts) buttons.get(t.name).dataset.parts = t.parts.map((x) => x.name).join(' ');
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
    // SPEC §2.1: the chip that says how many things are waiting for you sits
    // beside the mark. js/attention.js fills it.
    const waiting = el('div', { id: 'waiting' });
    const hints = keyHints();
    // SPEC §3.2: a land's name is drawn on the ground, and letters are HTML.
    const labels = el('div', { id: 'world-labels' });
    const hud = el('div', { id: 'hud' },
        labels,
        el('div', { id: 'brand', className: 'glass' },
            el('span', { className: 'mark', textContent: 'splatworld' }),
            el('span', { className: 'rule' }), waiting),
        top.node, pipe.node, frame.node, bar,
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
    return { top, you, stats: pipe.cells, frame, buttons, bodies, notice, map,
        mapBox, scale, waiting, hints, alt };
}

// A key opens its surface; Escape closes whatever is open. Neither fires while
// somebody is typing — a land called "5" has to be nameable.
function bindKeys(doc, show) {
    doc.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        if (e.key === 'Escape') { show('World'); return; }
        const name = keyed(e.key);
        if (!name) return;
        e.preventDefault();
        show(name);
    });
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
    frame.parts.hidden = !TABS.find((t) => t.name === at.tab)?.parts;
    frame.title.textContent = at.tab;
    frame.node.dataset.open = at.tab === 'World' ? '' : '1';
    // Each panel is as wide as what it has to show (TABS.width).
    const want = TABS.find((t) => t.name === at.tab)?.width;
    frame.node.style.width = want ? `${want}px` : '';
}

// Where the player is standing and which way they are facing: the top of the
// screen, written from plain strings. The chrome decides nothing.
function place(top) {
    return {
        standing({ land, owner, right, may }) {
            if (land !== undefined) top.land.textContent = land;
            if (owner !== undefined) {
                top.owner.replaceChildren('Owner ', el('b', { textContent: owner }));
                top.owner.style.visibility = owner ? '' : 'hidden';
            }
            if (right !== undefined) top.right.textContent = right;
            if (may !== undefined) top.right.dataset.may = may ? '1' : '';
        },
        at(lon, lat, h, heading) {
            const ns = lat >= 0 ? 'N' : 'S';
            const ew = lon >= 0 ? 'E' : 'W';
            top.coords.textContent =
                `${Math.abs(lat).toFixed(4)}${ns} ${Math.abs(lon).toFixed(4)}${ew}`
                + ` \u00b7 ${Math.round(h)} m`;
            if (Number.isFinite(heading)) top.face(((heading % 360) + 360) % 360);
        },
    };
}

// What the bar and the corners say about you and about the world's progress.
function state(f) {
    const { you, stats, buttons, notice } = f;
    return {
        // A surface with something waiting behind it says so without being
        // opened. A count hung on a part shows on the surface that holds it.
        badge(name, n) {
            const b = buttons.get(surfaceOf(name)?.tab ?? name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n > 0) b.append(el('span', { className: 'count', textContent: String(n) }));
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
        // Credits are not a stage of the route — they are on the chip that is
        // you, where a balance is read without opening anything.
        stat(key, value) {
            if (key === 'credits') {
                you.credits.replaceChildren(value ?? '\u2014', el('i', { textContent: 'CR' }));
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

export function mountHud(doc) {
    let open = 'World';
    const f = buildFrame(doc, (name) => show(name));
    // What a panel wants done when it is opened. A queue somebody else is
    // working out of is out of date the moment it is drawn, and opening the
    // surface is the player asking what is in it.
    const onShow = new Map();

    function show(name) {
        if (name === open && name !== 'World') name = 'World';
        open = name;
        showPanel(name, f);
        onShow.get(name)?.();
        return f.bodies.get(name);
    }

    bindKeys(doc, show);
    // The world is what the page opens on: every panel hidden, nothing docked.
    // Said once here rather than left to the markup, so the frame's state and
    // `open` cannot start out disagreeing.
    show(open);

    return {
        show,
        panel: (name) => f.bodies.get(name),
        whenShown(name, fn) { onShow.set(name, fn); },
        opened: () => open,
        ...state(f),
        ...place(f.top),
    };
}
