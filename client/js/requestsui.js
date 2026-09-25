// requestsui.js — Survey → Requests: who has asked for land, and what they
// wrote (EDT.19). Drawing them some is Parcels' (client/js/assignland.js); a
// request here takes the admin there with it chosen.

import * as api from './api.js';
import { empty } from './empty.js';
import { el } from './tabbar.js';

export function mountRequests(host, { draw } = {}) {
    const list = el('ol', { className: 'rq-list' });
    host.append(list);
    const refresh = async () => {
        const rows = await api.rpc('land_requests', { which: 'open' }).catch(() => []);
        const open = Array.isArray(rows) ? rows : [];
        if (!open.length) {
            list.replaceChildren(empty('Nobody is waiting',
                'Requests for land appear here, with the words the asker wrote.'));
            return open;
        }
        const admin = api.role() === 'admin';
        list.replaceChildren(...open.map((r) => {
            const go = el('button', { type: 'button', className: 'rq-draw',
                textContent: 'Draw their land' });
            go.hidden = !admin;
            go.onclick = () => draw?.(r.id);
            return el('li', { className: 'rq-row' }, el('b', { textContent: r.who }),
                el('span', { className: 'muted', textContent: r.note ?? '' }), go);
        }));
        return open;
    };
    return { refresh };
}
