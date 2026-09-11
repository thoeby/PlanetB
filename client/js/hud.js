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
export const TABS = [
    { name: 'World', glyph: 'circle(50%)', lede: '' },
    { name: 'Your land', glyph: 'polygon(0 0,100% 0,100% 100%,0 100%)',
        lede: 'The ground you own, and what stands on it.' },
    { name: 'Place', glyph: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
        lede: 'Put a product from the catalog on your own land.' },
    { name: 'Catalog', glyph: CUT(6),
        lede: 'Products anyone may build with. Register your own.' },
    { name: 'Submit', glyph: 'polygon(50% 0,100% 100%,0 100%)',
        lede: 'Send what you placed to be rendered.' },
    { name: 'Render pool', glyph: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)',
        lede: 'Tiles waiting to be compiled, and what they pay.' },
    { name: 'Permission', glyph: 'polygon(0 55%,40% 100%,100% 10%,88% 0,40% 78%,12% 43%)',
        lede: 'Rendered tiles waiting for a person to approve them.' },
    { name: 'Wallet', glyph: 'polygon(0 20%,100% 20%,100% 100%,0 100%)',
        lede: 'What you have, and what moved.' },
    { name: 'Share', glyph: 'circle(50%)',
        lede: 'A link that puts somebody else where you are standing.' },
    { name: 'Admin', glyph: 'polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)',
        lede: 'Properties land, features and products may carry.' },
    { name: 'Setup', glyph: 'circle(50%)',
        lede: 'Your account, your GeoServer, and the ground the world sits on.' },
];

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const stat = (key, label, tone) => {
    const value = el('span', { className: 'value', textContent: '—' });
    const node = el('div', { className: 'stat glass' },
        el('span', { className: 'label', textContent: label }), value);
    if (tone) node.dataset.tone = tone;
    node.dataset.stat = key;
    return { node, value };
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
            m.style.display = Math.abs(d) > 92 ? 'none' : '';
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

function tabBar(onPick) {
    const bar = el('div', { id: 'tabs', className: 'glass' });
    const buttons = new Map();
    for (const t of TABS) {
        const glyph = el('span', { className: 'glyph' });
        glyph.style.clipPath = t.glyph;
        const b = el('button', { type: 'button', className: 'tab' },
            glyph, el('span', { className: 'label', textContent: t.name }));
        b.setAttribute('aria-selected', String(t.name === 'World'));
        b.onclick = () => onPick(t.name);
        buttons.set(t.name, b);
        bar.append(b);
    }
    return { bar, buttons };
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
    const stats = {
        credits: stat('credits', 'Credits', 'accent'),
        approval: stat('approval', 'Awaiting approval', 'warn'),
        unsubmitted: stat('unsubmitted', 'Not yet submitted'),
    };
    const frame = panelFrame(() => show('World'));
    const { bar, buttons } = tabBar(show);

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

    const hud = el('div', { id: 'hud' },
        el('div', { id: 'brand', className: 'glass' },
            el('span', { className: 'mark', textContent: 'splatworld' }),
            el('span', { className: 'rule' }), who),
        top.node,
        el('div', { id: 'stats' }, ...Object.values(stats).map((x) => x.node)),
        frame.node, bar,
        el('div', { id: 'hints', className: 'glass' },
            el('span', {}, el('b', { textContent: 'Walk' }), ' W A S D'),
            el('span', {}, el('b', { textContent: 'Look' }), ' drag'),
            el('span', {}, el('b', { textContent: 'Fly' }), ' F')),
        el('div', { id: 'legend', className: 'glass' },
            el('span', { className: 'published' }, el('i'), 'Published'),
            el('span', { className: 'candidate' }, el('i'),
                'Candidate \u00b7 awaiting approval'),
            el('span', { className: 'mine' }, el('i'), 'Yours \u00b7 not yet submitted')),
        el('div', { id: 'crosshair' }, el('i'), el('i'), el('i'), el('i')));

    doc.body.append(el('div', { id: 'vignette' }), hud);
    return { top, who, stats, frame, buttons, bodies };
}

export function mountHud(doc) {
    let open = 'World';
    const { top, who, stats, frame, buttons, bodies } =
        buildFrame(doc, (name) => show(name));

    function show(name) {
        if (name === open && name !== 'World') name = 'World';
        open = name;
        for (const [tab, b] of buttons) b.setAttribute('aria-selected', String(tab === name));
        for (const [tab, host] of bodies) host.hidden = tab !== name;
        frame.title.textContent = name;
        frame.node.dataset.open = name === 'World' ? '' : '1';
        return bodies.get(name);
    }

    return {
        show,
        panel: (name) => bodies.get(name),
        opened: () => open,
        // A tab with something waiting behind it says so without being opened.
        badge(name, n) {
            const b = buttons.get(name);
            if (!b) return;
            b.querySelector('.count')?.remove();
            if (n > 0) b.append(el('span', { className: 'count', textContent: String(n) }));
        },
        signedIn(label) { who.textContent = label ?? 'not signed in'; },
        stat(key, value) {
            if (stats[key]) stats[key].value.textContent = value;
        },
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
                + ` · ${Math.round(h)} m`;
            if (Number.isFinite(heading)) top.face(((heading % 360) + 360) % 360);
        },
    };
}
