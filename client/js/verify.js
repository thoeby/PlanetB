// verify.js — Profile → Verify: a player is a verified person (PLAN-identity.md).
//
// Two ways, as §1 says: with the Swiss e-ID, or by asking an admin, who checks
// an ID document in person or on a call and never sees it uploaded. The page
// shows what the world says about you and asks it things; whether you are
// verified is the database's answer, and the database is what refuses
// (Invariant 6, db/0195).

import * as api from './api.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

export const UNLOCKS = 'Verifying unlocks getting land, holding a wallet, building and'
    + ' registering products. Walking, visiting and rendering are free.';

// What every refusal that wants a verified player says, and the way to it.
// `words` is the database's own sentence when there is one.
export function verifyFirst(host, open, words = 'Verify first') {
    const go = el('button', { type: 'button', className: 'bare verify-go',
        textContent: 'Verify' });
    go.onclick = () => open('Verify');
    host.replaceChildren(el('span', { textContent: `${words.split(' — ')[0]} — ` }), go);
    host.dataset.bad = '1';
}

export const needsVerifying = (err) => /Verify first/.test(errorText(err));

export const errorText = (err) => String(err?.body?.message ?? err?.message ?? err);

function said(v) {
    if (v.state === 'verified') {
        if (v.method === 'eid') return 'Verified with e-ID';
        if (v.method === 'operator') return 'Verified — the operator of this world';
        return `Verified by ${v.by}${v.how ? ` — ${v.how}` : ''}`;
    }
    if (v.state === 'waiting') return 'Waiting for an admin';
    if (v.state === 'refused') return `Not verified — refused: ${v.note}`;
    if (v.state === 'revoked') return `Not verified — revoked: ${v.note}`;
    return 'Not verified';
}

function field(label, props) {
    const input = el('input', { ...props, id: `verify-${props.name}` });
    return [el('label', { htmlFor: input.id, textContent: label }), input];
}

// The two ways to verify, as §1 lays them out.
function choicesOf() {
    const eid = el('button', { type: 'button', textContent: 'With e-ID' });
    const [gl, given] = field('given names', { type: 'text', name: 'given' });
    const [fl, family] = field('family name', { type: 'text', name: 'family' });
    const [bl, born] = field('birth date', { type: 'date', name: 'born' });
    const [hl, how] = field('how the admin can check it',
        { type: 'text', name: 'how', placeholder: 'in person, or a video call' });
    const ask = el('button', { type: 'button', className: 'primary',
        textContent: 'Ask an admin' });
    const node = el('div', {},
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'With e-ID' }),
            el('p', { className: 'muted', textContent: 'The swiyu app shows what is'
                + ' asked — over 18, nationality, and your name and birth date for a'
                + ' fingerprint the world keeps instead of them.' }), eid),
        el('div', { className: 'section verify-manual' },
            el('span', { className: 'label', textContent: 'Without e-ID' }),
            el('p', { className: 'muted', textContent: 'An admin checks an ID document'
                + ' in person or on a call. It is shown, never uploaded.' }),
            gl, given, fl, family, bl, born, hl, how, ask));
    return { node, eid, ask, given, family, born, how };
}

export function mountVerify(host, { onChange = () => {} } = {}) {
    const state = el('p', { className: 'verify-state' });
    const unlocks = el('p', { className: 'muted', textContent: UNLOCKS });
    const status = el('p', { className: 'status verify-status' });
    const c = choicesOf();
    const choices = c.node;
    const signedOut = el('p', { className: 'muted',
        textContent: 'Sign in to verify — Settings → Setup.' });
    host.append(el('div', { className: 'verify' }, state, unlocks, choices, status, signedOut));

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    // ID.0 is unrun here (PLAN-identity.md, Blocked): this world has no swiyu
    // verifier to hand a QR code out of, which is §3's "not reachable" case.
    c.eid.onclick = () => say('swiyu is not reachable from this world — try again,'
        + ' or verify without e-ID.', true);

    c.ask.onclick = async () => {
        try {
            await api.rpc('request_verification', { given_names: c.given.value,
                family_name: c.family.value, birth_date: c.born.value || null,
                how: c.how.value });
            say('Sent. An admin will check it with you.');
            await refresh();
            onChange();
        } catch (err) {
            say(errorText(err), true);
        }
    };

    let last = null;
    async function refresh() {
        const signed = Boolean(api.userId());
        signedOut.hidden = signed;
        state.hidden = unlocks.hidden = !signed;
        choices.hidden = true;
        if (!signed) { last = null; return null; }
        const v = await api.rpc('my_verification').catch(() => ({ state: 'none' }));
        state.textContent = said(v);
        state.dataset.state = v.state;
        choices.hidden = v.state === 'verified' || v.state === 'waiting';
        unlocks.hidden = v.state === 'verified';
        if (last && last !== v.state) status.textContent = '';
        last = v.state;
        return v;
    }

    // What an admin decides elsewhere shows up without asking, while the
    // panel is open to see it.
    setInterval(() => { if (host.offsetParent) refresh(); }, 4000);
    refresh();
    return { refresh };
}
