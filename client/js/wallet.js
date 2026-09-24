// wallet.js — cash in a wallet (PLAN-money.md): what you hold, what it did,
// and every way the page asks for money to move.
//
// Nothing here moves money. Each call writes an order that only the holder of
// the wallet may write (db/0196, Invariant 6); walletd carries it out against
// the issuer, and the wallet says whether it could. Rights and editions stay
// in the database (Invariant 5), and `buy` hands a licence over when the
// payment is in.

import * as api from './api.js';

export const myItems = () => api.rpc('my_items').catch(() => []);
export const history = (w) => api.rpc('wallet_history', { w, lim: 40 }).catch(() => []);

export const pay = (w, to, amount, message) =>
    api.rpc('wallet_pay', { w, to_who: to, amount, message });
export const request = (w, from, amount, message) =>
    api.rpc('wallet_request', { w, from_who: from, amount, message });
export const answer = (order, yes) => api.rpc('answer_request', { order_id: order, pay: yes });

export const handOver = (item, to) => api.rpc('hand_over', { item, to_who: to });
export const take = (item, yes) => api.rpc('take_item', { item, accept: yes });
export const drop = (item, at) => api.rpc('drop_item', { item, lon: at.lon, lat: at.lat,
    h: at.h ?? 0 });
export const pickUp = (item, at) => api.rpc('pick_up', { item, lon: at.lon, lat: at.lat,
    h: at.h ?? 0 });
export const itemsNear = (at) => api.rpc('items_near', { lon: at.lon, lat: at.lat, metres: 60 })
    .catch(() => []);

export const setPrice = (jobId, amount) => api.rpc('set_price', { job_id: jobId, amount });
export const withdrawPrice = (jobId) => api.rpc('withdraw_price', { job_id: jobId });

export const buy = (san) => api.rpc('buy', { san });
export const myBuys = () => api.rpc('my_buys').catch(() => ({}));

export const myRights = () =>
    api.select('asset_right', { select: 'san,holder_id,acquired_at' }).catch(() => []);

// The currency, as the admin named it (O3), or its code.
let unit = null;
export async function currency() {
    if (unit) return unit;
    const s = await api.rpc('app_settings').catch(() => ({}));
    unit = s.currency_symbol || s.currency_name || s.currency_code || '';
    return unit;
}
export const forget = () => { unit = null; };

export const money = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

// What the catalog offers before it shows a button: a licence already held is
// not for sale again, a sold-out edition is not for sale at all, and a buy on
// its way says so.
export function offerOf(asset, holds, buying) {
    if (holds) return { state: 'held', label: 'you hold this' };
    if (buying && !['failed', 'refused'].includes(buying.state)) {
        return { state: 'paying', label: 'paying…' };
    }
    if (asset.license === 'limited' && asset.issued >= asset.editions) {
        return { state: 'sold_out', label: 'sold out' };
    }
    const free = asset.license === 'cc0' || asset.license === 'free'
        || Number(asset.price) === 0;
    return { state: 'buy', label: free ? 'take a licence' : `buy for ${money(asset.price)}` };
}
