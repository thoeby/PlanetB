// Signing in once is signing in once: api.js mirrors the JWT into localStorage
// and picks it back up on a reload, in a new tab, and after the server is
// restarted — which opens a new tab, and is where a per-tab copy would have
// been lost. Its own file rather than client/test/api.test.js: the storage
// stand-in has to be installed before api.js is first imported.

import test from 'node:test';
import assert from 'node:assert/strict';

// A localStorage stand-in, installed before api.js is imported so the module
// sees it exactly as a browser would.
class FakeStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}

globalThis.localStorage = new FakeStorage();
const api = await import('../js/api.js');

const jwt = (claims) => [
    'x',
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
].join('.');

const live = () => jwt({ sub: 'u1', role: 'player', email: 'a@b.c',
    exp: Math.floor(Date.now() / 1000) + 3600 });

test('setToken writes the token to the browser store', () => {
    api.setToken(live());
    assert.equal(globalThis.localStorage.getItem('splatworld:jwt'), api.token());
});

test('restore brings a live session back', () => {
    const token = live();
    api.setToken(token);
    api.logout();                       // clears storage as well
    assert.equal(api.restore(), null);
    globalThis.localStorage.setItem('splatworld:jwt', token);
    const claims = api.restore();
    assert.equal(claims.sub, 'u1');
    assert.equal(api.token(), token);
    assert.equal(api.role(), 'player');
});

test('an expired stored token is dropped, not sent', () => {
    api.logout();
    globalThis.localStorage.setItem('splatworld:jwt',
        jwt({ sub: 'u1', role: 'player', exp: Math.floor(Date.now() / 1000) - 1 }));
    assert.equal(api.restore(), null);
    assert.equal(api.token(), null);
    assert.equal(globalThis.localStorage.getItem('splatworld:jwt'), null);
});

test('so is an unreadable one', () => {
    api.logout();
    globalThis.localStorage.setItem('splatworld:jwt', 'not-a-jwt');
    assert.equal(api.restore(), null);
    assert.equal(api.token(), null);
});

test('signing out clears the stored token', () => {
    api.setToken(live());
    api.logout();
    assert.equal(globalThis.localStorage.getItem('splatworld:jwt'), null);
    assert.equal(api.claims(), null);
});
