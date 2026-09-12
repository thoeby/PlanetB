// The session survives a reload: api.js mirrors the JWT into the tab's
// sessionStorage and picks it back up, so a signed-in player is not asked for
// a password every time the page reloads. Its own file rather than
// client/test/api.test.js: the storage stand-in has to be installed before
// api.js is first imported.

import test from 'node:test';
import assert from 'node:assert/strict';

// A sessionStorage stand-in, installed before api.js is imported so the module
// sees it exactly as a browser tab would.
class FakeStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}

globalThis.sessionStorage = new FakeStorage();
const api = await import('../js/api.js');

const jwt = (claims) => [
    'x',
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
].join('.');

const live = () => jwt({ sub: 'u1', role: 'player', email: 'a@b.c',
    exp: Math.floor(Date.now() / 1000) + 3600 });

test('setToken writes the token to the tab storage', () => {
    api.setToken(live());
    assert.equal(globalThis.sessionStorage.getItem('splatworld:jwt'), api.token());
});

test('restore brings a live session back', () => {
    const token = live();
    api.setToken(token);
    api.logout();                       // clears storage as well
    assert.equal(api.restore(), null);
    globalThis.sessionStorage.setItem('splatworld:jwt', token);
    const claims = api.restore();
    assert.equal(claims.sub, 'u1');
    assert.equal(api.token(), token);
    assert.equal(api.role(), 'player');
});

test('an expired stored token is dropped, not sent', () => {
    api.logout();
    globalThis.sessionStorage.setItem('splatworld:jwt',
        jwt({ sub: 'u1', role: 'player', exp: Math.floor(Date.now() / 1000) - 1 }));
    assert.equal(api.restore(), null);
    assert.equal(api.token(), null);
    assert.equal(globalThis.sessionStorage.getItem('splatworld:jwt'), null);
});

test('so is an unreadable one', () => {
    api.logout();
    globalThis.sessionStorage.setItem('splatworld:jwt', 'not-a-jwt');
    assert.equal(api.restore(), null);
    assert.equal(api.token(), null);
});

test('signing out clears the stored token', () => {
    api.setToken(live());
    api.logout();
    assert.equal(globalThis.sessionStorage.getItem('splatworld:jwt'), null);
    assert.equal(api.claims(), null);
});
