// hostingui.js — Work › Hosting: a land's files, kept by a tab for a term
// (TASKS-live.md LV.13). An owner offers one of their lands; anybody hosts it
// from this tab; after the term anybody settles it.

import { el } from './poolui.js';
import * as api from './api.js';
import { hostDuty, hostingHere, hostsOpen, offerHost } from './hosting.js';
import { settleDuty, termWords } from './duties.js';

const words = (err) => String(err?.body?.message ?? err?.message ?? err);

function hostRow(d, peers, say, refresh) {
    const li = el('li', { className: 'duty host' });
    li.dataset.duty = d.id;
    li.append(el('span', { className: 'duty-what', textContent:
        `${d.land} · ${d.files} file(s) · offered by ${d.offered_by_name} · ${termWords(d.term)}`
        + ` · ${Number(d.bounty).toFixed(2)} cr` }));
    if (d.state === 'open') {
        const take = el('button', { type: 'button', className: 'duty-host', textContent: 'Host',
            disabled: !peers?.id });
        take.onclick = () => hostDuty(d, peers, say).then(refresh, (e) => say(words(e), true));
        li.append(take);
        return li;
    }
    const ends = d.ends_at ? new Date(d.ends_at) : null;
    li.append(el('span', { className: 'duty-state muted', textContent:
        `hosted by ${d.claimed_by_name} until ${ends?.toLocaleTimeString() ?? '?'}`
        + ` · served ${d.served} · ${Math.round(Number(d.share) * 100)}% of its bytes` }));
    if (ends && ends <= new Date() && (hostingHere(d.id) || d.offered_by === api.userId())) {
        const settle = el('button', { type: 'button', className: 'duty-settle',
            textContent: 'Settle' });
        settle.onclick = () => settleDuty(d.id).then((done) => {
            say(`settled: ${Number(done.paid ?? 0).toFixed(2)} cr for`
                + ` ${Math.round(Number(d.share) * 100)}% of its bytes served`);
            return refresh();
        }, (e) => say(words(e), true));
        li.append(settle);
    }
    return li;
}

function offerForm(say, refresh) {
    const land = el('select', { className: 'host-land' });
    land.setAttribute('aria-label', 'land to host');
    const minutes = el('input', { type: 'number', min: '1', value: '60',
        className: 'host-minutes' });
    minutes.setAttribute('aria-label', 'minutes to host it');
    const bounty = el('input', { type: 'number', min: '0', step: '0.5', value: '0',
        className: 'host-bounty' });
    bounty.setAttribute('aria-label', 'bounty');
    const offer = el('button', { type: 'button', className: 'host-offer',
        textContent: 'Offer' });
    offer.onclick = () => offerHost(land.value, minutes.value, bounty.value).then(() => {
        say(`${land.selectedOptions[0]?.textContent} is offered to be hosted for`
            + ` ${minutes.value} min.`);
        return refresh();
    }, (e) => say(words(e), true));
    const form = el('div', { className: 'host-form row' },
        el('span', { textContent: 'Have your land hosted:' }), land, minutes, bounty, offer);
    const lands = async () => {
        const mine = await api.rpc('my_areas').catch(() => []);
        land.replaceChildren(...mine.map((a) => new Option(a.name ?? a.rules?.name ?? 'land',
            a.id)));
        form.hidden = !mine.length;
    };
    return { form, lands };
}

export function mountHosting(host, { peers }) {
    const list = el('ul', { className: 'duties rows' });
    const said = el('p', { className: 'hosting-said status' });
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
    };
    const offer = offerForm(say, () => refresh());
    host.append(el('div', { className: 'note', textContent:
        'A land’s files, kept by this tab for a term and handed to whoever asks;'
        + ' paid for the share of them it served.' }), offer.form, list, said);

    async function refresh() {
        await offer.lands();
        const rows = await hostsOpen().catch(() => []);
        list.replaceChildren(...(rows.length ? rows.map((d) => hostRow(d, peers, say, refresh))
            : [el('li', { className: 'muted', textContent: 'Nobody has a land to host.' })]));
        return rows;
    }
    return { refresh, say };
}
