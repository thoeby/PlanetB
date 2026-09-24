// worldcash.js — Admin → World: the world's cash, for an admin.
//
// PLAN-money.md M5 and O3: what every new player's wallet starts with, and
// what the money is called. Both are the world's settings (app_setting,
// db/0156); set_app_setting refuses anybody who is not an admin (Invariant
// 6). The currency's code is the issuer's and cannot change once coins exist:
// it is shown, not asked.

import * as api from './api.js';
import { errorText } from './verify.js';
import { forget } from './wallet.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const FIELDS = [
    ['starting_amount', 'starting amount', 'number', 'what a verified player starts with'],
    ['currency_name', 'currency name', 'text', 'what the money is called'],
    ['currency_symbol', 'currency symbol', 'text', 'what the bar writes after a balance'],
];

export function mountWorldCash(host) {
    const inputs = new Map(FIELDS.map(([key, label, type, hint]) => [key,
        el('input', { type, placeholder: hint, ariaLabel: label })]));
    const code = el('p', { className: 'muted world-code' });
    const status = el('p', { className: 'status world-status' });
    const save = el('button', { type: 'button', className: 'primary', textContent: 'Save' });
    host.append(el('div', { className: 'world-cash' }, code,
        ...FIELDS.map(([key, label]) => el('label', {},
            el('span', { textContent: label }), inputs.get(key))), save, status));

    save.onclick = async () => {
        try {
            for (const [key] of FIELDS) {
                await api.rpc('set_app_setting', { key, value: inputs.get(key).value });
            }
            forget();
            status.textContent = 'Saved.';
            status.dataset.bad = '';
        } catch (err) {
            status.textContent = errorText(err);
            status.dataset.bad = '1';
        }
    };

    async function refresh() {
        const s = await api.rpc('app_settings').catch(() => ({}));
        const admin = api.role() === 'admin';
        save.disabled = !admin;
        code.textContent = `The issuer's currency is ${s.currency_code ?? 'not known yet'}.`
            + (admin ? '' : ' Only an admin changes these.');
        inputs.get('starting_amount').value = s.starting_amount ?? '100';
        inputs.get('currency_name').value = s.currency_name ?? '';
        inputs.get('currency_symbol').value = s.currency_symbol ?? '';
    }

    refresh();
    return { refresh };
}
