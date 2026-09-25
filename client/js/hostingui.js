// hostingui.js — Work › Hosting: a land's files, kept by a tab for a term
// (TASKS-live.md LV.13, laid out again in TASKS-ui.md UI.7).
//
// The page says what hosting is before it asks anything: a land's files live
// in the tabs of whoever looks at them, and hosting pays one tab to keep them
// for a while. On the left, offering your own land — with what it holds; on
// the right, the lands on offer as cards, and what this tab is hosting now.

import { el } from './poolui.js';
import * as api from './api.js';
import { hostDuty, hostingHere, hostsOpen, offerHost } from './hosting.js';
import { settleDuty, termWords } from './duties.js';
import { empty } from './empty.js';

const words = (err) => String(err?.body?.message ?? err?.message ?? err);
const mb = (n) => `${(Number(n ?? 0) / 1e6).toFixed(1)} MB`;

const INTRO = [
    ['Offer', 'The owner offers a land for a term, with a bounty from their wallet.'],
    ['Host', 'Somebody hosts it: their tab fetches every file the land names and hands'
        + ' each to whoever asks, while it is open.'],
    ['Settle', 'After the term the host is paid the share of the land’s bytes other'
        + ' players got from them; the rest goes back.'],
];

function intro() {
    return el('div', { className: 'hs-intro' },
        el('p', { className: 'hs-lede', textContent: 'A land’s files — its models'
            + ' and its tiles — live in the tabs of whoever is looking at them. A land'
            + ' nobody is looking at is kept by the world’s node alone. Hosting pays'
            + ' somebody’s tab to keep them for a while.' }),
        el('ol', { className: 'hs-steps' }, ...INTRO.map(([h, t], i) => el('li', {},
            el('span', { className: 'n', textContent: String(i + 1) }),
            el('b', { textContent: h }), el('span', { textContent: t })))));
}

function settleButton(d, say, refresh) {
    const settle = el('button', { type: 'button', className: 'duty-settle',
        textContent: 'Settle' });
    settle.onclick = () => settleDuty(d.id).then((done) => {
        say(`settled: ${Number(done.paid ?? 0).toFixed(2)} cr for`
            + ` ${Math.round(Number(d.share) * 100)}% of its bytes served`);
        return refresh();
    }, (e) => say(words(e), true));
    return settle;
}

// One offer, as a card: the land, what it holds, for how long, for how much,
// and the one thing to do with it now.
function hostRow(d, peers, say, refresh) {
    const bytes = (d.region?.files ?? []).reduce((n, f) => n + Number(f.bytes ?? 0), 0);
    const li = el('li', { className: 'duty host hs-card' },
        el('div', { className: 'hs-card-head' }, el('b', { textContent: d.land }),
            el('span', { className: 'mono', textContent:
                `${Number(d.bounty).toFixed(2)} cr` })),
        el('span', { className: 'duty-what muted', textContent:
            `${d.files} file(s) · ${mb(bytes)} · offered by ${d.offered_by_name}`
            + ` · ${termWords(d.term)}` }));
    li.dataset.duty = d.id;
    if (d.state === 'open') {
        const take = el('button', { type: 'button', className: 'duty-host primary',
            textContent: 'Host', disabled: !peers?.id || d.offered_by === api.userId() });
        take.title = peers?.id ? '' : 'This tab is not a peer, so it cannot host';
        take.onclick = () => hostDuty(d, peers, say).then(refresh, (e) => say(words(e), true));
        li.append(take);
        return li;
    }
    const ends = d.ends_at ? new Date(d.ends_at) : null;
    const share = Math.round(Number(d.share) * 100);
    li.append(el('span', { className: 'duty-state', textContent:
        `hosted by ${d.claimed_by_name} until ${ends?.toLocaleTimeString() ?? '?'}`
        + ` · served ${d.served} · ${share}% of its bytes` }),
    el('div', { className: 'hs-meter' }, el('i', { style: `width:${share}%` })));
    if (ends && ends <= new Date() && (hostingHere(d.id) || d.offered_by === api.userId())) {
        li.append(settleButton(d, say, refresh));
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
    const holds = el('p', { className: 'hs-holds muted' });
    const offer = el('button', { type: 'button', className: 'host-offer primary',
        textContent: 'Offer' });
    offer.onclick = () => offerHost(land.value, minutes.value, bounty.value).then(() => {
        say(`${land.selectedOptions[0]?.textContent} is offered to be hosted for`
            + ` ${minutes.value} min.`);
        return refresh();
    }, (e) => say(words(e), true));
    const what = async () => {
        const files = land.value
            ? await api.rpc('region_files', { area: land.value }).catch(() => []) : [];
        const bytes = files.reduce((n, f) => n + Number(f.bytes ?? 0), 0);
        holds.textContent = `${files.length} file(s) · ${mb(bytes)} would be hosted`;
    };
    land.onchange = what;
    const form = el('div', { className: 'host-form hs-box' },
        el('span', { className: 'label', textContent: 'Have your land hosted' }),
        el('label', { textContent: 'Land' }, land), holds,
        el('div', { className: 'row' }, el('label', { textContent: 'For how many minutes' },
            minutes), el('label', { textContent: 'Bounty (cr)' }, bounty)), offer);
    const lands = async () => {
        const mine = await api.rpc('my_areas').catch(() => []);
        land.replaceChildren(...mine.map((a) => new Option(a.name ?? a.rules?.name ?? 'land',
            a.id)));
        form.hidden = !mine.length;
        await what();
    };
    return { form, lands };
}

function hereCard(peers) {
    const node = el('div', { className: 'hs-box hs-here' });
    const draw = () => {
        const served = peers?.served ?? [];
        node.replaceChildren(el('span', { className: 'label', textContent: 'This tab' }),
            el('p', { textContent: peers?.id
                ? `A peer: holds ${peers.held.size} file(s), has served ${served.length}`
                    + ` (${mb(served.reduce((n, s) => n + s.bytes, 0))}) this visit.`
                : 'Not a peer: it reads files from the world, and cannot host.' }));
    };
    return { node, draw };
}

export function mountHosting(host, { peers }) {
    const list = el('ul', { className: 'duties hs-cards' });
    const said = el('p', { className: 'hosting-said status' });
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
    };
    const offer = offerForm(say, () => refresh());
    const here = hereCard(peers);
    host.append(intro(), el('div', { className: 'hs-cols' },
        el('div', { className: 'hs-left' }, offer.form, here.node),
        el('div', { className: 'hs-right' },
            el('span', { className: 'label', textContent: 'Lands to host' }), list, said)));

    async function refresh() {
        await offer.lands();
        here.draw();
        const rows = await hostsOpen().catch(() => []);
        list.replaceChildren(...(rows.length ? rows.map((d) => hostRow(d, peers, say, refresh))
            : [empty('Nobody has a land to host', 'When an owner offers one, it is here'
                + ' to take.', { as: 'li' })]));
        return rows;
    }
    return { refresh, say };
}
