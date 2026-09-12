// auth.js — the sign-in panel. Plain DOM, no framework, no build step.
//
// It owns nothing but the form: register() and login() are RPCs, the token is
// held by api.js, and what the signed-in user may then do is decided by
// row-level security in the database, never here (Invariant 6).

import * as api from './api.js';

const HTML = `
<form class="auth-form" autocomplete="on">
  <label>email <input name="email" type="email" required autocomplete="username"></label>
  <label>password <input name="pw" type="password" required minlength="8"
      autocomplete="current-password"></label>
  <div class="auth-buttons">
    <button type="submit" name="act" value="login">sign in</button>
    <button type="submit" name="act" value="register">create account</button>
  </div>
</form>
<div class="auth-who" hidden>
  <span class="auth-email"></span>
  <span class="auth-role"></span>
  <button type="button" class="auth-out">sign out</button>
</div>
<div class="auth-name-row" hidden>
  <label>your name <input class="auth-name" type="text" maxlength="40"
      autocomplete="nickname" placeholder="what the world calls you"></label>
  <button type="button" class="auth-save-name">save name</button>
</div>
<p class="auth-status" role="status"></p>`;

function renderIdentity(host, form, who) {
    const c = api.claims();
    form.hidden = Boolean(c);
    who.hidden = !c;
    // SPEC §3.1: signing up is email, password, then what to call you. The
    // name is asked for where the account is, and only once there is one.
    host.querySelector('.auth-name-row').hidden = !c;
    if (c) {
        host.querySelector('.auth-email').textContent = c.email ?? c.sub;
        host.querySelector('.auth-role').textContent = `(${api.role()})`;
    }
    return c;
}

// What this account is called, as the world knows it — not as this tab last
// typed it. A tab that signs in somewhere else shows that name.
async function showName(host, say) {
    const me = await api.rpc('me').catch(() => null);
    const field = host.querySelector('.auth-name');
    if (me?.name) {
        field.value = me.name;
        say(`signed in as ${me.name}`);
    }
    return me;
}

async function signIn(act, email, pw) {
    if (act === 'register') await api.register(email, pw);
    return api.login(email, pw);
}

// Invariant 6: the database decides what a name may be, and what it said
// belongs next to the field that caused it, never only in the console.
async function saveName(host, say) {
    const field = host.querySelector('.auth-name');
    try {
        const me = await api.rpc('set_my_name', { name: field.value });
        say(`signed in as ${me.name}`);
    } catch (err) {
        say(String(err.message ?? err), true);
    }
}

export function mountAuth(host, { onChange } = {}) {
    host.innerHTML = HTML;
    const form = host.querySelector('.auth-form');
    const who = host.querySelector('.auth-who');
    const status = host.querySelector('.auth-status');
    let waiting = null;
    // A token restored from the tab's storage is a session too: without this a
    // reloaded tab would go quiet instead of asking to sign in again when the
    // token finally expires.
    let hadSession = Boolean(api.claims());
    const render = () => onChange?.(renderIdentity(host, form, who));

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    async function submit(event) {
        event.preventDefault();
        const data = new FormData(form);
        const act = event.submitter?.value ?? 'login';
        try {
            say(act === 'register' ? 'creating account…' : 'signing in…');
            await signIn(act, String(data.get('email')), String(data.get('pw')));
            form.reset();
            hadSession = true;
            say('');
            render();
            await showName(host, say);
            waiting?.resolve(api.token());
            waiting = null;
        } catch (err) {
            // 403 is what login() raises on bad credentials; anything else is
            // the API being unreachable or the account already existing.
            say(err.status === 403 ? 'wrong email or password' : String(err.message), true);
        }
    }

    host.querySelector('.auth-save-name')
        .addEventListener('click', () => saveName(host, say));
    form.addEventListener('submit', submit);
    who.querySelector('.auth-out').addEventListener('click', () => {
        api.logout();
        render();
        say('signed out');
    });

    // api.js calls this when the token is missing, about to expire or refused.
    // It resolves once the user signs in again, so the interrupted request can
    // simply be retried; a still-anonymous tab resolves to null immediately.
    api.onAuthRequired(() => {
        // A tab that never signed in stays anonymous rather than blocking on a
        // dialog nobody asked for; only an expired session waits for the user.
        if (!hadSession) return null;
        if (!waiting) {
            render();
            say('session expired, please sign in again');
            waiting = {};
            waiting.promise = new Promise((resolve) => { waiting.resolve = resolve; });
        }
        return waiting.promise;
    });

    render();
    return { render, say };
}
