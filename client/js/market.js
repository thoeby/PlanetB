// market.js — what the Marketplace and the Inventory read (TASKS-ui.md UI.3–6).
//
// Nothing here moves money or decides anything: orders are db/0206's, rights
// db/0207's, and who may read what is row-level security's (Invariant 6). The
// numbers the pages show — how often a product is placed, what it sold, what
// came in — are counted from the rows as they are, never stored.

import * as api from './api.js';
import { getAsset, searchAssets } from './catalog.js';
import { myAccount } from './wallet.js';

const FIELDS = 'san,name,category,license,price,editions,issued,tris,bbox,sha256,'
    + 'thumb_sha256,creator_id,created_at,type,parts,pointer,policy,term';

const inList = (xs) => `in.(${[...new Set(xs)].join(',')})`;

export const me = () => api.userId();

export async function assetsBySan(sans) {
    if (!sans.length) return [];
    return api.select('asset', { san: inList(sans), select: FIELDS }).catch(() => []);
}

// Every product there is, newest first; the Shop filters by kind.
export const shopProducts = () => searchAssets({ limit: 500 });

export const myProducts = () => (me()
    ? api.select('asset', { creator_id: `eq.${me()}`, select: FIELDS,
        order: 'created_at.desc' }).catch(() => [])
    : Promise.resolve([]));

// The licences this player holds (asset_right is public to read, so it is
// filtered to the holder here — the rows are theirs either way).
export const myRights = () => (me()
    ? api.select('asset_right', { holder_id: `eq.${me()}`,
        select: 'san,acquired_at,ref,follow,sha256,until', order: 'acquired_at.desc' })
        .catch(() => [])
    : Promise.resolve([]));

// How many of each product stand in the world, and how many of those are
// this player's doing (placed on land they build on is not recorded per
// player, so "yours" is the ones on land they own).
export async function placedCounts(sans) {
    if (!sans.length) return new Map();
    const rows = await api.select('instance', { san: inList(sans), select: 'san',
        deleted_at: 'is.null', limit: '20000' }).catch(() => []);
    const out = new Map();
    for (const r of rows) out.set(r.san, (out.get(r.san) ?? 0) + 1);
    return out;
}

// The orders for this maker's products (db/0206 lets the maker read them),
// newest first, with the buyer's name.
export async function salesOf(sans) {
    if (!sans.length) return [];
    const rows = await api.select('store_order', { san: inList(sans),
        select: 'id,san,buyer,qty,amount,state,created_at,paid_at,provider',
        order: 'created_at.desc', limit: '500' }).catch(() => []);
    const names = new Map();
    for (const id of new Set(rows.map((r) => r.buyer))) {
        names.set(id, await api.rpc('player_name', { who: id }).catch(() => null));
    }
    return rows.map((r) => ({ ...r, buyer_name: names.get(r.buyer) ?? 'somebody' }));
}

// What came into this player's account for their products: the ledger rows an
// order paid (ref buy:… or sub:…, db/0206), with the product's name.
export async function earnings() {
    const account = await myAccount();
    if (!account) return { account: null, rows: [] };
    const rows = await api.select('ledger', { credit: `eq.${account.id}`,
        select: 'id,at,amount,ref', order: 'id.desc', limit: '500' }).catch(() => []);
    const sales = rows.filter((r) => /^(buy|sub):/.test(r.ref))
        .map((r) => ({ ...r, san: r.ref.split(':')[1], amount: Number(r.amount) }));
    return { account, rows: sales };
}

// A product on its own, for a detail column.
export const product = (san) => getAsset(san);

// Sums by day, the last `days` days, oldest first: what a bar chart draws.
export function byDay(rows, { days = 14, at = 'created_at', value = () => 1,
    now = new Date() } = {}) {
    const out = [];
    const day = (d) => d.toISOString().slice(0, 10);
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);
        out.push({ day: day(d), v: 0 });
    }
    const index = new Map(out.map((o, i) => [o.day, i]));
    for (const r of rows) {
        const i = index.get(day(new Date(r[at])));
        if (i !== undefined) out[i].v += value(r);
    }
    return out;
}

export const money = (n) => Number(n ?? 0).toFixed(2);
