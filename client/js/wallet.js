// wallet.js — the money a player has, where it went, and the two ways they
// spend it: a bounty on a tile nobody has drawn yet, and a licence on somebody
// else's asset.
//
// Nothing here moves money. `pay`, `set_bounty`, `buy_asset` and
// `transfer_asset_right` are one SQL transaction each, `ref`-idempotent, over
// an append-only ledger (Invariant 5); this asks and displays.

import * as api from './api.js';

// The balance view and the ledger are private — own wallet only (WP0
// deviation 4) — so an anonymous tab simply gets nothing.
export async function myAccount() {
    const [row] = await api.select('account', { select: 'id,owner_id', limit: '1' })
        .catch(() => []);
    if (!row) return null;
    const [bal] = await api.select('balance',
        { select: 'account_id,amount', account_id: `eq.${row.id}` }).catch(() => []);
    return { ...row, amount: Number(bal?.amount ?? 0) };
}

// The last few movements, newest first, as the wallet shows them: what came in
// is positive, what went out is negative, and `ref` says why.
export async function myLedger(accountId, limit = 12) {
    const rows = await api.select('ledger', {
        select: 'id,at,debit,credit,amount,ref',
        or: `(debit.eq.${accountId},credit.eq.${accountId})`,
        order: 'id.desc', limit: String(limit),
    }).catch(() => []);
    return rows.map((r) => ({
        ...r,
        delta: r.credit === accountId ? Number(r.amount) : -Number(r.amount),
    }));
}

export const setBounty = (jobId, amount) =>
    api.rpc('set_bounty', { job_id: jobId, amount });

export const buyAsset = (san) => api.rpc('buy_asset', { san });

export const transferRight = (san, toUser, amount = 0) =>
    api.rpc('transfer_asset_right', { san, to_user: toUser, amount });

// What the catalog needs to know before it offers a buy button: a right
// already held is not for sale again, and a sold-out edition is not for sale
// at all.
export function offerOf(asset, holds) {
    if (holds) return { state: 'held', label: 'you hold this' };
    if (asset.license === 'limited' && asset.issued >= asset.editions) {
        return { state: 'sold_out', label: 'sold out' };
    }
    const free = asset.license === 'cc0' || asset.license === 'free'
        || Number(asset.price) === 0;
    return { state: 'buy', label: free ? 'take a licence' : `buy for ${asset.price}` };
}

export const myRights = () =>
    api.select('asset_right', { select: 'san,holder_id,acquired_at' }).catch(() => []);
