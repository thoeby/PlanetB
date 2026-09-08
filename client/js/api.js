// api.js — the only place the client talks to PostgREST.
//
// The JWT lives in a module variable and nowhere else. localStorage would hand
// it to every script on the origin and survive the tab; a token that dies with
// the tab is the smaller blast radius. Nothing here decides what the caller may
// do — every write is settled by row-level security in the database
// (Invariant 6); a 401 or 403 from PostgREST is that decision arriving.

const DEFAULTS = { api: 'http://localhost:3000', files: 'http://localhost:8080' };

// Refresh this many seconds before `exp`, so a request never leaves with a
// token the server will have expired by the time it lands.
const SKEW_S = 60;

const state = { ...DEFAULTS, token: null, claims: null, refresh: null };

export class ApiError extends Error {
    constructor(status, body, url) {
        super(`${status} ${url}: ${body?.message ?? body?.hint ?? body ?? ''}`.trim());
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

// Endpoints come from <meta name="splatworld:api"> / "splatworld:files" so the
// same static files work against compose, a dev box or a deployment.
export function configure(opts = {}) {
    if (typeof document !== 'undefined') {
        for (const key of ['api', 'files']) {
            const el = document.querySelector(`meta[name="splatworld:${key}"]`);
            if (el?.content) state[key] = el.content;
        }
    }
    Object.assign(state, opts);
    return { api: state.api, files: state.files };
}

export const endpoints = () => ({ api: state.api, files: state.files });

// ------------------------------------------------------------------- identity

function claimsOf(token) {
    const part = token.split('.')[1];
    if (!part) throw new Error('malformed token');
    const json = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
    return JSON.parse(json);
}

export function setToken(token) {
    state.token = token || null;
    state.claims = token ? claimsOf(token) : null;
    return state.claims;
}

export const token = () => state.token;
export const claims = () => state.claims;
export const userId = () => state.claims?.sub ?? null;
export const role = () => state.claims?.role ?? 'anon';
export const expiresIn = () =>
    (state.claims?.exp ? state.claims.exp - Math.floor(Date.now() / 1000) : 0);

export function logout() {
    state.token = null;
    state.claims = null;
}

// Called when the token is missing, stale or rejected. Return a fresh token (or
// null to stay anonymous); auth.js installs the login dialog here.
export function onAuthRequired(fn) {
    state.refresh = fn;
}

async function refresh() {
    if (!state.refresh) return null;
    const fresh = await state.refresh();
    if (!fresh) return null;
    setToken(fresh);
    return state.token;
}

// ------------------------------------------------------------------- requests

async function send(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const url = path.startsWith('http') ? path : state.api + path;
    if (auth && state.token && expiresIn() < SKEW_S) {
        logout();
        await refresh();
    }
    const h = { Accept: 'application/json', ...headers };
    if (auth && state.token) h.Authorization = `Bearer ${state.token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(url, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function parse(res, url) {
    if (res.status === 204 || res.headers.get('content-length') === '0') return null;
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* PostgREST error pages */ }
    if (!res.ok) throw new ApiError(res.status, body, url);
    return body;
}

export async function request(path, opts = {}) {
    let res = await send(path, opts);
    // The token was rejected (revoked, secret rotated, clock skew): drop it, ask
    // for another, and give the call exactly one more chance.
    if (res.status === 401 && opts.auth !== false) {
        logout();
        if (await refresh()) res = await send(path, opts);
    }
    return parse(res, path);
}

// ---------------------------------------------------------------- rest + rpc

const qs = (params) => {
    const s = new URLSearchParams(params).toString();
    return s ? `?${s}` : '';
};

export const select = (table, params = {}) => request(`/${table}${qs(params)}`);

export const insert = (table, rows, params = {}) =>
    request(`/${table}${qs(params)}`, {
        method: 'POST', body: rows, headers: { Prefer: 'return=representation' },
    });

export const update = (table, params, patch) =>
    request(`/${table}${qs(params)}`, {
        method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' },
    });

export const remove = (table, params) => request(`/${table}${qs(params)}`, { method: 'DELETE' });

export const rpc = (name, args = {}) => request(`/rpc/${name}`, { method: 'POST', body: args });

// -------------------------------------------------------------------- session

export async function register(email, pw) {
    return rpc('register', { email, pw });
}

export async function login(email, pw) {
    const jwt = await request('/rpc/login', {
        method: 'POST', body: { email, pw }, auth: false,
    });
    if (typeof jwt !== 'string' || !jwt) throw new Error('login returned no token');
    return setToken(jwt);
}
