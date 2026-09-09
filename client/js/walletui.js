// walletui.js — the wallet panel: what I have, where it went, and a bounty on
// a tile I want drawn.
//
// A bounty is escrowed the moment it is set (db/0006_publish.sql) and paid out
// pro rata by reported GPU time when the tile publishes. That is why the panel
// says "escrowed" rather than "spent": the money is out of the wallet and not
// yet anyone else's.

import { myAccount, myLedger, setBounty } from './wallet.js';

const HTML = `
<div class="wallet-head">wallet</div>
<div class="wallet-balance muted">—</div>
<ul class="wallet-ledger"></ul>
<div class="wallet-bounty">
  <input class="wallet-amount" type="number" min="0" step="1" value="10">
  <span class="wallet-target muted">no tile chosen</span>
  <button type="button" class="wallet-set" disabled>set bounty</button>
</div>
<p class="wallet-status muted"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const sign = (n) => (n > 0 ? `+${n}` : String(n));

// A ledger line reads as what it was for: the ref is the world's own word for
// it (bounty:{job}, pay:{job}:{worker}, buy:{san}:{user}).
function ledgerRow(row) {
    return el('li', { className: 'wallet-line' },
        el('span', { className: 'wallet-delta', textContent: sign(row.delta) }),
        el('span', { className: 'muted', textContent: ` ${row.ref}` }));
}

export function mountWallet(host) {
    host.innerHTML = HTML;
    const q = (sel) => host.querySelector(sel);
    const state = { account: null, job: null, tile: null };

    const say = (msg, bad = false) => {
        const node = q('.wallet-status');
        node.textContent = msg;
        node.className = `wallet-status ${bad ? 'bad' : 'muted'}`;
    };

    async function refresh() {
        const account = await myAccount();
        state.account = account;
        q('.wallet-balance').textContent = account
            ? `${account.amount} in ${account.id.slice(0, 8)}`
            : 'sign in to see your wallet';
        const rows = account ? await myLedger(account.id) : [];
        q('.wallet-ledger').replaceChildren(...rows.map(ledgerRow));
        return account;
    }

    // Build mode hands the panel the tile the player is looking at, so a
    // bounty is set on the job that would draw it.
    function target(tile, job) {
        state.tile = tile;
        state.job = job;
        q('.wallet-target').textContent = tile
            ? `${tile.z}/${tile.x}/${tile.y}${job ? ` · job ${job}` : ' · no job yet'}`
            : 'no tile chosen';
        q('.wallet-set').disabled = !job;
        return state;
    }

    q('.wallet-set').onclick = async () => {
        if (!state.job) return;
        try {
            await setBounty(state.job, Number(q('.wallet-amount').value));
            say('escrowed until the tile publishes');
            await refresh();
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    };

    refresh();
    return { refresh, target, state, say };
}
