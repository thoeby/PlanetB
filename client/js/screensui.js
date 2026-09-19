// screensui.js — the screens waiting for a word (FND.15, D13).
//
// A billboard's picture is somebody else's advertisement on somebody's land,
// so `port_write` writes it as pending (db/0169) and everybody goes on seeing
// what is there until the land's approver says yes. Saying yes compiles
// nothing: the splats are exactly what they were, and only the picture drawn
// over them changes — so this is beside the submissions rather than among
// them, where approving opens render jobs.

import * as api from './api.js';
import { el } from './permissionui.js';

const picture = (sha) => `${api.endpoints().files}/assets/${sha}.png`;

function row(entry, acts) {
    const li = el('li', { className: 'scr-screen' });
    li.dataset.instance = entry.instance;
    const shot = el('img', { className: 'scr-shot', alt: '',
        src: picture(String(entry.pending ?? '')) });
    const go = el('button', { type: 'button', className: 'scr-go',
        textContent: 'Go there' });
    go.onclick = () => acts.go(entry);
    const yes = el('button', { type: 'button', className: 'scr-yes primary',
        textContent: 'Approve' });
    yes.onclick = () => acts.approve(entry);
    const no = el('button', { type: 'button', className: 'scr-no',
        textContent: 'Refuse' });
    no.onclick = () => acts.refuse(entry);
    li.append(shot,
        el('span', { className: 'scr-what',
            textContent: `${entry.by} set a screen on ${entry.land}` }),
        el('div', { className: 'row' }, go, yes, no));
    return li;
}

export function mountScreens(host, { onGo = () => {}, onDecided = () => {} } = {}) {
    const head = el('span', { className: 'label', textContent: 'Screens' });
    const note = el('div', { className: 'note',
        textContent: 'A screen is what somebody else will read. Approving one'
            + ' compiles nothing — only the picture over the splats changes.' });
    const list = el('ul', { className: 'rows scr-list' });
    const status = el('p', { className: 'scr-status status' });
    const section = el('div', { className: 'section scr-section' },
        head, note, list, status);
    section.hidden = true;
    host.append(section);

    const state = { rows: [] };
    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const decide = async (rpc, entry, said) => {
        try {
            await api.rpc(rpc, { p_instance: entry.instance, p_port: entry.port });
            await refresh();
            say(said);
            onDecided();
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    };

    const acts = {
        go: (entry) => { onGo({ lon: entry.lon, lat: entry.lat }); say('Go and look at it.'); },
        approve: (entry) => decide('approve_screen', entry,
            `the screen on ${entry.land} is what everybody sees now`),
        refuse: (entry) => decide('refuse_screen', entry,
            `the screen on ${entry.land} stays as it was`),
    };

    async function refresh() {
        if (!api.token()) { state.rows = []; section.hidden = true; return []; }
        state.rows = await api.rpc('screens_waiting').catch(() => []);
        section.hidden = state.rows.length === 0;
        head.textContent = state.rows.length === 1
            ? '1 screen waiting for you' : `${state.rows.length} screens waiting for you`;
        list.replaceChildren(...state.rows.map((e) => row(e, acts)));
        return state.rows;
    }

    return { node: section, refresh, acts, rows: () => state.rows,
        said: () => status.textContent };
}
