// hosting.js — a land's files, kept by a tab of yours for a term (LV.13).
//
// The world keeps the offer (db/0214 `duty` op `host`): the land's files by
// CID and sha256, fixed when it was offered, a term and a bounty. Taking one
// is this tab's doing: it says which of its peers hosts (`claim_host`), then
// fetches every file the way it fetches any (client/js/peers.js) — checked
// against its sha256, kept, and told to the world as held — and serves them
// while it is open. Who got a file from it says so under their own login
// (`host_served`); after the term the host is paid for the share it served.

import * as api from './api.js';

export const offerHost = (areaId, minutes, bounty = 0) => api.rpc('offer_host',
    { area: areaId, term: `${Math.max(1, Number(minutes) || 60)} minutes`,
        bounty: Number(bounty) || 0 });

export const hostsOpen = () => api.select('duty', {
    op: 'eq.host', state: 'in.(open,claimed)', order: 'created_at.desc', limit: '50' });

// What this tab hosts, kept per tab: a reload of the page is the same tab.
const KEY = 'splatworld.hosting';
const store = () => globalThis.localStorage;
const mine = () => {
    try { return JSON.parse(store().getItem(KEY) ?? '{}'); } catch { return {}; }
};
const keep = (all) => {
    try { store().setItem(KEY, JSON.stringify(all)); } catch { /* a private window */ }
};

export const hostingHere = (dutyId) => Boolean(mine()[dutyId]);

// Every file of the region into this tab; the count it holds.
export async function fetchRegion(peers, files, say = () => {}) {
    let held = 0;
    for (const f of files) {
        say(`fetching ${held + 1} of ${files.length}…`);
        await peers.get(f.cid, f.sha256, `file ${f.sha256.slice(0, 8)}`).then(() => { held += 1; },
            () => {});
    }
    await peers.tell();
    return held;
}

export async function hostDuty(duty, peers, say = () => {}) {
    if (!peers?.id) throw new Error('This tab is not a peer, so it cannot host anything.');
    say('taking it…');
    const got = await api.rpc('claim_host', { duty: duty.id, peer: peers.id });
    keep({ ...mine(), [duty.id]: { files: got.files, ends_at: got.ends_at } });
    const held = await fetchRegion(peers, got.files, say);
    say(`Hosting ${held} file(s) of ${duty.land} until`
        + ` ${new Date(got.ends_at).toLocaleTimeString()}.`);
    return { held, endsAt: got.ends_at };
}

// A reload keeps hosting what it took, for as long as the term runs.
export async function resumeHosting(peers) {
    const now = Date.now();
    for (const h of Object.values(mine())) {
        if (new Date(h.ends_at).getTime() > now) await fetchRegion(peers, h.files).catch(() => 0);
    }
}
