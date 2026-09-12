// getland.js — what the Your land panel shows somebody who has none.
//
// SPEC §2.4 "Get land" and §3.2: land is assigned by an admin, so a player
// with none is told who that is and given one thing to do about it. The old
// panel said "draw an area on Your land in QGIS", which is not how land is
// come by and left a new player with nowhere to start.

import * as api from './api.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const names = (who) => (who.length > 1
    ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`
    : who[0] ?? 'nobody yet');

export function mountGetLand(host) {
    const who = el('p', { className: 'muted' });
    const note = el('input', { type: 'text', id: 'land-want',
        placeholder: 'near Visp, ~2 ha' });
    const send = el('button', { type: 'button', className: 'primary',
        textContent: 'Request land' });
    const status = el('p', { className: 'status getland-status' });
    const block = el('div', { className: 'section getland' },
        el('span', { className: 'label', textContent: 'Get land' }),
        el('p', {}, 'Land is assigned by an admin.'),
        who,
        el('label', { htmlFor: 'land-want',
            textContent: 'what land do you want' }),
        note, send, status);
    host.append(block);

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    send.onclick = async () => {
        try {
            await api.rpc('request_land', { note: note.value });
            say('Sent. Your request is with the admin.');
        } catch (err) {
            // Invariant 6: the database decided, and it said why.
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    };

    async function refresh(areas) {
        // Nobody signed in has no land and no way to ask for any; the panel
        // says so by not being there, and asks the API nothing.
        block.hidden = Boolean(areas?.length) || !api.userId();
        if (block.hidden) return;
        who.textContent = `Ask ${names(await api.rpc('admins').catch(() => []))}.`;
        const mine = (await api.rpc('land_requests', { which: 'all' })
            .catch(() => []));
        const open = (Array.isArray(mine) ? mine : [])
            .find((r) => r.state === 'open');
        if (open) {
            note.value = open.note;
            say('Your request is with the admin.');
        }
    }

    return { refresh, node: block };
}
