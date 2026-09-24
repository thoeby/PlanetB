// processservers.js — the process servers a player has, and which one this tab
// is using (TASKS-flows.md FL.1, db/0196).
//
// Two kinds of row: the operator's own checking server (db/0156 `elx_url`),
// shown to everybody as "World's server" and changed only in Setup, and the
// player's own list, which the world keeps for them and shows to nobody else.
// Which one is chosen is this browser's business, so it is kept here and not
// in the world.

import * as api from './api.js';
import { checkingServer } from './flowcheck.js';

export const WORLD_SERVER = 'world';
const CHOSEN = 'splatworld.flows.server';

// Every server this player can choose from, World's server first.
export async function servers() {
    const [world, mine] = await Promise.all([
        checkingServer(),
        api.select('process_server', { select: 'id,name,url', order: 'name.asc' })
            .catch(() => []),
    ]);
    const out = world ? [{ id: WORLD_SERVER, name: 'World’s server', url: world,
        fixed: true }] : [];
    return out.concat(mine.map((r) => ({ ...r, fixed: false })));
}

export const saveServer = (id, name, url) =>
    api.rpc('save_process_server', { id: id ?? null, name, url });

export const removeServer = (id) => api.rpc('delete_process_server', { id });

export function chosenId() {
    try {
        return window.localStorage.getItem(CHOSEN);
    } catch {
        return null;
    }
}

export function choose(id) {
    try {
        if (id) window.localStorage.setItem(CHOSEN, id);
        else window.localStorage.removeItem(CHOSEN);
    } catch {
        /* storage refused: the choice lasts as long as the page */
    }
}

// The chosen server out of a list, or the first one when the choice is gone.
export const pick = (list, id = chosenId()) =>
    list.find((s) => s.id === id) ?? list[0] ?? null;
