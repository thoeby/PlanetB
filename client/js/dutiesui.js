// dutiesui.js — Work › Flows: somebody's flow, run on a server of yours
// (TASKS-live.md LV.10). Each offer says whose flow on which land, for how
// long and for how much; Run puts it on the server chosen beside it. What this
// tab runs reports its runs back, and is settled once its term is over.

import { el } from './poolui.js';
import { servers } from './processservers.js';
import { dutiesOpen, onTermEnd, runDuty, runningHere, sendReceipts, settleDuty, termWords }
    from './duties.js';

const words = (err) => String(err?.body?.message ?? err?.message ?? err);

function offerRow(d, mineServers, say, refresh) {
    const li = el('li', { className: 'duty' });
    li.dataset.duty = d.id;
    const what = `${d.flow_name ?? 'a flow'} on ${d.land} · offered by ${d.offered_by_name}`
        + ` · ${termWords(d.term)} · ${Number(d.bounty).toFixed(2)} cr`;
    li.append(el('span', { className: 'duty-what', textContent: what }));
    if (d.state === 'open') {
        const which = el('select', { className: 'duty-server' });
        which.setAttribute('aria-label', 'run on');
        which.append(...mineServers.map((s) => new Option(s.name, s.id)));
        const run = el('button', { type: 'button', className: 'duty-run', textContent: 'Run',
            disabled: !d.may_claim || !mineServers.length });
        run.onclick = async () => {
            const server = mineServers.find((s) => s.id === which.value);
            try {
                await runDuty(d, server, say);
                await refresh();
            } catch (err) {
                say(words(err), true);
            }
        };
        li.append(which, run);
    } else {
        const ends = d.ends_at ? new Date(d.ends_at) : null;
        li.append(el('span', { className: 'duty-state muted', textContent:
            `run by ${d.claimed_by_name} until ${ends?.toLocaleTimeString() ?? '?'}`
            + ` · ${d.runs} run(s)` }));
        if (runningHere(d.id) && ends && ends <= new Date()) {
            const settle = el('button', { type: 'button', className: 'duty-settle',
                textContent: 'Settle' });
            settle.onclick = async () => {
                try {
                    await sendReceipts(d.id).catch(() => 0);
                    const done = await settleDuty(d.id);
                    say(`settled: ${done.runs} run(s)`);
                    await refresh();
                } catch (err) {
                    say(words(err), true);
                }
            };
            li.append(settle);
        }
    }
    return li;
}

export function mountDuties(host) {
    const list = el('ul', { className: 'duties rows' });
    const said = el('p', { className: 'duties-said status' });
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
    };
    host.append(el('div', { className: 'note', textContent:
        'A flow somebody offered, run on a process server of yours for its term,'
        + ' under a key that reaches only its own land.' }), list, said);

    let wake = null;
    async function refresh() {
        const [offers, mine] = await Promise.all([dutiesOpen().catch(() => []),
            servers().catch(() => [])]);
        const own = mine.filter((s) => !s.fixed);
        for (const d of offers) {
            if (runningHere(d.id) && d.state === 'claimed') await sendReceipts(d.id).catch(() => 0);
        }
        list.replaceChildren(...(offers.length ? offers.map((d) => offerRow(d, own, say, refresh))
            : [el('li', { className: 'muted', textContent: 'Nobody has offered a flow.' })]));
        wake = onTermEnd(offers, refresh, wake);
        return offers;
    }
    return { refresh, say };
}
