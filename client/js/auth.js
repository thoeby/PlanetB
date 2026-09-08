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
<p class="auth-status" role="status"></p>`;

export function mountAuth(host, { onChange } = {}) {
    host.innerHTML = HTML;
    const form = host.querySelector('.auth-form');
    const who = host.querySelector('.auth-who');
    const status = host.querySelector('.auth-status');
    let waiting = null;
    let hadSession = false;

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    function render() {
        const c = api.claims();
        form.hidden = Boolean(c);
        who.hidden = !c;
        if (c) {
            host.querySelector('.auth-email').textContent = c.email ?? c.sub;
            host.querySelector('.auth-role').textContent = `(${api.role()})`;
        }
        onChange?.(c);
    }

    async function submit(event) {
        event.preventDefault();
        const data = new FormData(form);
        const email = String(data.get('email'));
        const pw = String(data.get('pw'));
        const act = event.submitter?.value ?? 'login';
        try {
            say(act === 'register' ? 'creating account…' : 'signing in…');
            if (act === 'register') await api.register(email, pw);
            await api.login(email, pw);
            form.reset();
            hadSession = true;
            say('');
            render();
            waiting?.resolve(api.token());
            waiting = null;
        } catch (err) {
            // 403 is what login() raises on bad credentials; anything else is
            // the API being unreachable or the account already existing.
            say(err.status === 403 ? 'wrong email or password' : String(err.message), true);
        }
    }

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
