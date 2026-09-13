// hud.js — the chrome around the world: where you are, what you own, and one
// visible control for everything the tool can do.
//
// It holds no policy and no data. It builds the frame, owns which tab is open,
// and hands each tab a body element for whichever module fills it. A module
// mounted here neither knows nor cares that it is in a tab.

const CUT = (n) => `polygon(${n}px 0, 100% 0, 100% calc(100% - ${n}px),`
    + ` calc(100% - ${n}px) 100%, 0 100%, 0 ${n}px)`;

// Every tab is a thing a person does. "World" is the world itself — choosing it
// closes whatever is open rather than showing a panel.
//
// `group` and `key` are the design's: four named groups along the hotbar, and a
// number key for each so nothing is reachable only by aiming at it. `width` is
// how wide that panel wants to be — a catalog of pictures needs more than a
// wallet.
export const TABS = [
    { name: 'World', group: 'Look', key: '1', glyph: 'circle(50%)', lede: '' },
    { name: 'Share', group: 'Look', key: '9', glyph: 'circle(50%)', width: 470,
        lede: 'A link that puts somebody else where you are standing.' },
    { name: 'Your land', group: 'Build', key: '2',
        glyph: 'polygon(0 0,100% 0,100% 100%,0 100%)', width: 500,
        lede: 'The ground you own, and what stands on it.' },
    { name: 'Place', group: 'Build', key: '3',
        glyph: 'polygon(50% 0,100% 50%,50% 100%,0 50%)', width: 470,
        lede: 'Put a product from the catalog on your own land.' },
    { name: 'Catalog', group: 'Build', key: '4', glyph: CUT(6), width: 666,
        lede: 'Products anyone may build with. Register your own.' },
    { name: 'Submit', group: 'Build', key: '5',
        glyph: 'polygon(50% 0,100% 100%,0 100%)', width: 470,
        lede: 'Send what you placed to be rendered.' },
    { name: 'Render pool', group: 'Economy', key: '6',
        glyph: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)', width: 540,
        lede: 'Tiles waiting to be compiled, and what they pay.' },
    { name: 'Permission', group: 'Economy', key: '7',
        glyph: 'polygon(0 55%,40% 100%,100% 10%,88% 0,40% 78%,12% 43%)', width: 500,
        lede: 'What somebody built, waiting for a person to say yes.' },
    { name: 'Wallet', group: 'Economy', key: '8',
        glyph: 'polygon(0 20%,100% 20%,100% 100%,0 100%)', width: 500,
        lede: 'What you have, and what moved.' },
    { name: 'Admin', group: 'System', key: '0',
        glyph: 'polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)', width: 666,
        lede: 'What things may say about themselves, and what the compiler'
            + ' makes of them.' },
    { name: 'Setup', group: 'System', key: '`',
        glyph: 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,'
            + '32% 57%,2% 35%,39% 35%)', width: 470,
        lede: 'Your account, your GeoServer, and the ground the world sits on.' },
];

export const GROUPS = ['Look', 'Build', 'Economy', 'System'];

// The five stages of the route through the app, in order, as the chrome shows
// them. Credits are not a stage: they sit in their own chip beside these.
export const STAGES = [
    { key: 'placed', label: 'Placed' },
    { key: 'pool', label: 'In pool' },
    { key: 'rendered', label: 'Rendered', tone: 'accent' },
    { key: 'awaiting', label: 'Awaiting', tone: 'warn' },
    { key: 'published', label: 'Published', tone: 'accent' },
];

// Which tab a key opens. Typing into a field must not teleport you, so the
// caller checks that first.
export const keyed = (key) => TABS.find((t) => t.key === key)?.name ?? null;

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

// The hotbar: four named groups, each tab with the key that opens it. A key
// hint is not decoration — it is the only way to learn that the keys work.
function tabBar(onPick) {
    const bar = el('div', { id: 'tabs', className: 'glass' });
    const buttons = new Map();
    for (const name of GROUPS) {
        const tabs = el('div', { className: 'tabs' });
        for (const t of TABS.filter((x) => x.group === name)) {
            buttons.set(t.name, tabButton(t, onPick));
            tabs.append(buttons.get(t.name));
        }
        bar.append(el('div', { className: 'hotgroup' },
            el('span', { className: 'name', textContent: name }), tabs));
    }
    return { bar, buttons };
}

function tabButton(t, onPick) {
    const glyph = el('span', { className: 'glyph' });
    glyph.style.clipPath = t.glyph;
    const b = el('button', { type: 'button', className: 'tab' },
        el('span', { className: 'key', textContent: t.key }), glyph,
        el('span', { className: 'label', textContent: t.name }));
    b.setAttribute('aria-selected', String(t.name === 'World'));
    b.dataset.tab = t.name;
    b.onclick = () => onPick(t.name);
    return b;
}

// The route through the app, always visible: how many things you have placed,
// how many tiles are in the pool, how many of those a renderer holds, how many
// are waiting for a person, how many are published. Credits sit beside them.
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
    const credits = el('span', { className: 'value', textContent: '—' });
    cells.credits = credits;
    const chip = el('div', { id: 'credits', className: 'glass' },
        el('span', { className: 'label', textContent: 'Credits' }), credits);
    return { node: el('div', { id: 'stats' }, strip, chip), cells };
}

function panelFrame(onClose) {
    const title = el('span', { className: 'title' });
    const close = el('button', { type: 'button', className: 'close',
        textContent: '×', title: 'close' });
    close.onclick = onClose;
    const body = el('div', { className: 'body' });
    const node = el('aside', { id: 'panel', className: 'glass' },
        el('header', {}, title, close), body);
    return { node, title, body };
}

// Everything that is on screen, built once. `show` is passed in because the
// tab buttons need it before mountHud has defined it.
function buildFrame(doc, show) {
    const top = topCentre();
    const who = el('span', { className: 'who', textContent: 'not signed in' });
    const pipe = pipeline();
    const frame = panelFrame(() => show('World'));
    const { bar, buttons } = tabBar(show);
    const map = el('canvas', { id: 'minimap', width: 240, height: 240 });
    const scale = el('span', { className: 'scale', textContent: 'Map · M' });

    // Each tab gets its body once and keeps it, so a module mounted into it
    // survives the panel being closed and opened again. The lede is written
    // here rather than by each module, so a panel nobody has built yet still
    // says what it will be for.
    const bodies = new Map();
    for (const t of TABS) {
        const host = el('div', { className: 'tab-body' });
        host.hidden = true;
        if (t.lede) host.append(el('p', { className: 'lede', textContent: t.lede }));
        bodies.set(t.name, host);
        frame.body.append(host);
    }

    const notice = el('div', { id: 'notice', className: 'glass' });
    notice.hidden = true;
    // SPEC §2.1: the chip that says how many things are waiting for you sits
    // next to who you are. js/attention.js fills it.
    const waiting = el('div', { id: 'waiting' });
    // SPEC §3.2: a land's name is drawn on the ground, and letters are HTML.
    const labels = el('div', { id: 'world-labels' });
    const hud = el('div', { id: 'hud' },
        labels,
        el('div', { id: 'brand', className: 'glass' },
            el('span', { className: 'mark', textContent: 'splatworld' }),
            el('span', { className: 'rule' }), who, waiting),
        top.node, pipe.node, frame.node, bar,
        el('div', { id: 'corner' },
            el('div', { id: 'hints', className: 'glass' },
                el('span', {}, el('b', { textContent: 'Walk' }), ' W A S D'),
                el('span', {}, el('b', { textContent: 'Look' }), ' drag'),
                el('span', {}, el('b', { textContent: 'Fly' }), ' F'),
                el('span', {}, el('b', { textContent: 'Run' }), ' Shift'),
                el('span', {}, el('b', { textContent: 'Close panel' }), ' Esc')),
            el('div', { id: 'map', className: 'glass' }, map, scale)),
        el('div', { id: 'legend', className: 'glass' },
            el('span', { className: 'published' }, el('i'), 'Published'),
            el('span', { className: 'candidate' }, el('i'),
                'Candidate \u00b7 awaiting approval'),
            el('span', { className: 'mine' }, el('i'), 'Yours \u00b7 not yet submitted'),
            el('span', { className: 'theirs' }, el('i'), 'No build rights')),
        el('div', { id: 'crosshair' }, el('i'), el('i'), el('i'), el('i')),
        notice);

    doc.body.append(el('div', { id: 'vignette' }), hud);
    return { top, who, stats: pipe.cells, frame, buttons, bodies, notice, map,
        scale, waiting };
}

// A number key opens its panel; Escape closes whatever is open. Neither fires
// while somebody is typing — a land called "5" has to be nameable.
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

// Which panel is on screen, and the frame dressed for it.
function showPanel(name, { buttons, bodies, frame }) {
    for (const [tab, b] of buttons) b.setAttribute('aria-selected', String(tab === name));
    for (const [tab, host] of bodies) host.hidden = tab !== name;
    frame.title.textContent = name;
    frame.node.dataset.open = name === 'World' ? '' : '1';
    // Each panel is as wide as what it has to show (TABS.width).
    const want = TABS.find((t) => t.name === name)?.width;
    frame.node.style.width = want ? `${want}px` : '';
}

export function mountHud(doc) {
    let open = 'World';
    const f = buildFrame(doc, (name) => show(name));
    const { top, who, stats, buttons, bodies, notice, waiting } = f;
    // What a panel wants done when it is opened. A queue somebody else is
    // working out of is out of date the moment it is drawn, and opening the tab
    // is the player asking what is in it.
    const onShow = new Map();

    function show(name) {
        if (name === open && name !== 'World') name = 'World';
        open = name;
        showPanel(name, f);
        onShow.get(name)?.();
        return bodies.get(name);
    }

    bindKeys(doc, show);
    // The world is what the tab opens on: every panel hidden, nothing docked.
    // Said once here rather than left to the markup, so the frame's state and
    // `open` cannot start out disagreeing.
    show(open);

    return {
        show,
        panel: (name) => bodies.get(name),
        whenShown(name, fn) { onShow.set(name, fn); },
        opened: () => open,
        // A tab with something waiting behind it says so without being opened.
        badge(name, n) {
            const b = buttons.get(name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n > 0) b.append(el('span', { className: 'count', textContent: String(n) }));
        },
        signedIn(label) { who.textContent = label ?? 'not signed in'; },
        // Where the attention chip is mounted (SPEC §2.1).
        waitingSlot: () => waiting,
        // The one line an empty world needs: what is missing, and where to do
        // something about it. Empty text takes it away.
        notice(text) {
            notice.textContent = text ?? '';
            notice.hidden = !text;
        },
        stat(key, value) {
            if (stats[key]) stats[key].textContent = value;
        },
        // The minimap, and the scale it is drawn at.
        minimap: () => f.map,
        mapScale(text) { f.scale.textContent = text; },
        // Where the player is standing: the land under them, who owns it, and
        // whether they may build. Plain strings — the HUD decides nothing.
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
