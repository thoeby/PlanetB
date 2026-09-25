// triggerwire.js — the 3D view's side of LV.2: how far each thing is, what
// was clicked, which key was pressed, and one line that says what happened.
//
// client/js/triggers.js decides what a firing is; this only measures and
// listens. A key is offered on screen before it does anything (PLAYER-RUN.md:
// a key a player needs is a key the page shows).

import * as api from './api.js';
import { Triggers, triggersOf } from './triggers.js';

const CLICK_PX = 48;

function line(id, cls) {
    const node = document.createElement('div');
    node.id = id;
    node.className = `trigger-line ${cls}`;
    node.setAttribute('role', 'status');
    document.body.append(node);
    return node;
}

// The listening thing nearest where the pointer went down, on the screen.
function clicked(pc, camera, canvas, things, e) {
    const rect = canvas.getBoundingClientRect();
    let best = null;
    for (const t of things) {
        const s = camera.camera.worldToScreen(t.entity.getPosition(), new pc.Vec3());
        if (s.z <= 0) continue;
        const d = Math.hypot(s.x - (e.clientX - rect.left), s.y - (e.clientY - rect.top));
        if (d < CLICK_PX && (!best || d < best.d)) best = { d, row: t.row };
    }
    return best?.row ?? null;
}

export function mountTriggers({ pc, preview, camera, canvas, building, clock }) {
    const said = line('trigger-said', 'said');
    const offer = line('trigger-offer', 'offer');
    let hide = null;
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
        clearTimeout(hide);
        hide = setTimeout(() => { said.textContent = ''; }, 6000);
    };
    const triggers = new Triggers({ clock, say });

    // Every placed thing that listens for anything, and how far it is.
    const near = () => {
        const eye = camera.getPosition();
        const out = [];
        for (const [id, entity] of preview.entities) {
            const row = preview.rows.get(id);
            if (!row || String(id).startsWith('placing:') || !triggersOf(row).length) continue;
            const p = entity.getPosition();
            out.push({ row, metres: Math.hypot(p.x - eye.x, p.z - eye.z), entity });
        }
        return out;
    };

    const onKey = (when) => (e) => {
        if (building() || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) return;
        const things = near();
        if (when === 'down' && e.code === 'KeyE') triggers.use(things);
        triggers.key(e.key, when, things);
    };
    window.addEventListener('keydown', onKey('down'));
    window.addEventListener('keyup', onKey('up'));

    canvas.addEventListener('click', (e) => {
        if (building()) return;
        const hit = clicked(pc, camera, canvas, near(), e);
        if (hit) triggers.click(hit);
    });

    // Once every few frames: the near and far edges, and what may be pressed.
    const tick = () => {
        const things = near();
        triggers.move(things);
        const offers = triggers.offers(things);
        offer.textContent = offers.map((o) =>
            `${o.key} — ${o.what === 'use' ? 'use' : 'press'} ${o.row.name ?? o.row.san}`)
            .join('   ');
    };
    // LV.3: what things near here were made to say (a flow's Post), once each.
    let heard = 0;
    const hear = async (lon, lat) => {
        const notes = await api.rpc('notes_near',
            { p_lon: lon, p_lat: lat, p_metres: 200, p_after: heard }).catch(() => []);
        for (const n of notes ?? []) {
            heard = Math.max(heard, Number(n.id) || 0);
            say(`${n.name} says: ${n.text}`);
        }
    };
    return { triggers, tick, say, hear };
}
