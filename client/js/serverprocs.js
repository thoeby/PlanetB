// serverprocs.js — the Processes section of "On <server>" (TASKS-flows.md
// FL.3, docs/design/flows-servers.md §3a).
//
// A process server's processes, as that server lists them. Open shows one on
// the canvas without letting it be changed; Save into my land… makes it a flow
// of the world's, byte for byte as the server returned it; Dup, Ren and Del act
// on the server and say what they did there.

import { el } from './poolui.js';
import { ask } from './flowlist.js';
import { processApi } from '../flow/server/process.js';
import { failWords } from '../flow/server/client.js';
import { section, act } from './servertab.js';

const copyName = (taken, name) => {
    let want = `Copy of ${name}`;
    for (let i = 2; taken.includes(want); i++) want = `Copy of ${name} ${i}`;
    return want;
};

// One process's line.
function line(p, list, bag, reload) {
    const s = bag.server();
    const api = processApi(s.url);
    const tell = (e) => bag.say(failWords(e, s.name));
    const li = el('li', { className: 'fl-remote' },
        el('span', { className: 'pick', textContent: p.name }));
    li.dataset.process = p.name;
    li.append(
        act('Open', 'open', () => bag.open(s, p).catch(tell)),
        act('Save into my land…', 'keep', () => bag.intoLand(s, p).catch(tell)),
        act('Dup', 'dup', () => api.duplicate(p.id, copyName(list.map((x) => x.name), p.name))
            .then(reload, tell)),
        act('Ren', 'ren', () => ask(bag.dialogs(), {
            title: `Rename ${p.name} on ${s.name}`, value: p.name, ok: 'Rename',
            onOk: (name) => api.rename(p.id, name).then(reload),
        })),
        act('Del', 'del', () => ask(bag.dialogs(), {
            title: `Delete process ${p.name} on ${s.name}? Jobs that run it stop working.`,
            value: p.name, ok: 'Delete',
            onOk: (typed) => {
                if (typed !== p.name) throw new Error('Type the name to delete it.');
                return api.remove(p.id).then(reload);
            },
        })));
    return li;
}

export function mountProcesses(host, bag) {
    const part = section(host, 'Processes', {
        load: () => processApi(bag.server().url).list()
            .catch((e) => { throw new Error(failWords(e, bag.server().name)); }),
        draw(rows, list) {
            if (!list.length) {
                rows.append(el('li', { className: 'muted',
                    textContent: `${bag.server().name} has no processes yet.` }));
            }
            for (const p of list) rows.append(line(p, list, bag, () => part.run()));
        },
    });
    return part;
}
