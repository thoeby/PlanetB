// playersui.js — Settings → Players, for an admin (PLAN-identity.md §1).
//
// The requests to be verified without e-ID, each with the name and birth date
// as the player typed them — which the world forgets as soon as the admin
// decides (I2) — and every player with how they were verified, so a
// verification can be revoked with a note the player reads.
//
// A field somebody is typing into is made once per request and moved into
// each redraw (HANDOFF §2, "a panel that redraws is a panel that loses
// things").

import * as api from './api.js';
import { errorText } from './verify.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

function keeper(map, id, make) {
    if (!map.has(id)) map.set(id, make());
    return map.get(id);
}

const METHOD = { eid: 'e-ID', manual: 'by an admin', operator: 'operator' };

function request(r, { act, noteFor }) {
    const note = noteFor(`r${r.id}`, 'checked in person');
    const yes = el('button', { type: 'button', className: 'primary', textContent: 'Confirm' });
    const no = el('button', { type: 'button', textContent: 'Refuse' });
    yes.onclick = () => act(() => api.rpc('decide_verification',
        { request_id: r.id, confirm: true, words: note.value || 'checked in person' }),
    (v) => (v.state === 'verified' ? `${v.who} is verified.`
        : `${v.who} was refused: ${v.note}`));
    no.onclick = () => act(() => api.rpc('decide_verification',
        { request_id: r.id, confirm: false, words: note.value }),
    (v) => `${v.who} was refused: ${v.note}`);
    return el('li', { className: 'players-request' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: r.who }),
            el('div', { className: 'sub',
                textContent: `${r.given_names} ${r.family_name} · born ${r.birth_date}`
                    + `${r.how ? ` · ${r.how}` : ''}` })),
        el('div', { className: 'end' }, note, yes, no));
}

function player(p, { act, noteFor }) {
    const line = p.state === 'verified'
        ? `verified · ${METHOD[p.method] ?? p.method}${p.by ? ` · ${p.by}` : ''}`
        : p.state === 'revoked' ? `revoked · ${p.note}` : 'not verified';
    const end = el('div', { className: 'end' });
    if (p.state === 'verified' && p.method !== 'operator') {
        const note = noteFor(`p${p.id}`, 'why');
        const revoke = el('button', { type: 'button', textContent: 'Revoke' });
        revoke.onclick = () => act(() => api.rpc('revoke_verification',
            { player: p.id, note: note.value }), (v) => `${v.who} is no longer verified.`);
        end.append(note, revoke);
    }
    return el('li', { className: 'players-player' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: p.who }),
            el('div', { className: 'sub', textContent: line })), end);
}

export function mountPlayers(host) {
    const waiting = el('ul', { className: 'rows players-waiting' });
    const everyone = el('ul', { className: 'rows players-all' });
    const status = el('p', { className: 'status players-status' });
    const notes = new Map();
    host.append(el('div', { className: 'players' },
        el('span', { className: 'label', textContent: 'Waiting to be verified' }), waiting,
        el('span', { className: 'label', textContent: 'Every player' }), everyone, status));

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };
    const act = async (fn, done) => {
        try {
            const r = await fn();
            say(done(r));
        } catch (err) {
            say(errorText(err), true);
        }
        refresh();
    };

    const noteFor = (id, placeholder) => keeper(notes, id, () => el('input',
        { type: 'text', placeholder, ariaLabel: 'note' }));
    const ctx = { act: (...a) => act(...a), noteFor };

    let drawn = '';
    async function refresh() {
        if (api.role() !== 'admin') {
            drawn = '';
            waiting.replaceChildren(el('li', { className: 'muted',
                textContent: 'Only an admin verifies players.' }));
            everyone.replaceChildren();
            return;
        }
        const [open, all] = await Promise.all([
            api.rpc('verification_requests').catch(() => []),
            api.rpc('players').catch(() => [])]);
        // A card is rebuilt only when it would say something different: a
        // button redrawn under a hand is a press that goes nowhere.
        const seen = JSON.stringify([open, all]);
        if (seen === drawn) return;
        drawn = seen;
        waiting.replaceChildren(...(open.length ? open.map((r) => request(r, ctx))
            : [el('li', { className: 'muted', textContent: 'Nobody is waiting.' })]));
        everyone.replaceChildren(...all.map((p) => player(p, ctx)));
    }

    // What an admin decides elsewhere shows up without asking, while the
    // panel is open to see it.
    setInterval(() => { if (host.offsetParent) refresh(); }, 4000);
    refresh();
    return { refresh };
}
