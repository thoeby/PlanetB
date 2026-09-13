// places.js — the map's search box (SPEC §2.3, §3.8 step 3).
//
// "Search box: land name, player name, product name → results on the map." The
// map is the 240 px one in the corner, so the results are a short list under
// it and picking one takes you there. find_places answers; this decides
// nothing.

import * as api from './api.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter(Boolean));
    return node;
};

export function mountPlaces(host, { onGo = () => {} } = {}) {
    if (!host) return { search: async () => [] };
    const field = el('input', { className: 'map-find', type: 'search',
        placeholder: 'find a place or a player' });
    const list = el('ul', { className: 'map-found' });
    host.append(el('div', { className: 'map-search' }, field, list));

    async function search(q = field.value) {
        const found = q.trim()
            ? await api.rpc('find_places', { q, limit: 8 }).catch(() => [])
            : [];
        draw(list, found, onGo);
        return found;
    }

    // On change rather than on every keystroke: a search that asks the world
    // eight times while somebody types a name is eight answers they did not
    // wait for, arriving in whatever order the network chose.
    field.onchange = () => search();
    field.onsearch = () => search();
    return { search, field };
}

function draw(list, found, onGo) {
    list.replaceChildren(...found.map((place) => {
        const go = el('button', { type: 'button', className: 'map-go',
            textContent: 'Go' });
        go.onclick = () => onGo(place);
        return el('li', {},
            el('span', { className: 'map-place',
                textContent: `${place.name} · ${place.owner ?? 'nobody'}` }),
            go);
    }));
    list.hidden = !found.length;
}
