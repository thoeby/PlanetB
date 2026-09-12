// The three processes a worker tab needs: PostgREST, the nginx file store, and
// something serving client/ over http.
//
// The other browser tests answer the page's requests by route interception,
// which is enough to look at a world. A worker changes it — it uploads, it
// registers, it submits — so it needs the real API and the real store. And it
// needs an origin the browser calls secure, or WebCrypto and the Cache API are
// not there at all: hence localhost, over a real socket, rather than a made-up
// hostname.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync }
    from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

import { CLIENT, REPO, FILES_ROOT } from './serve.js';

const API_PORT = 3000;
const FILES_PORT = 8080;
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    // A browser refuses a stylesheet served as anything else, and then the
    // page renders correctly and completely unstyled.
    '.css': 'text/css', '.woff2': 'font/woff2',
    '.sog': 'application/octet-stream', '.webp': 'image/webp',
};

const up = async (url) => fetch(url).then((r) => r.ok || r.status === 404).catch(() => false);

// An API that answers is not the same as an API that knows this database.
// PostgREST caches the schema at startup, so one left running across a
// `make db-reset` answers 200 to everything and PGRST202 to every RPC — and a
// suite that reuses it fails at sign-in, which reads like a broken login.
async function knowsTheSchema(url) {
    const res = await fetch(`${url}/rpc/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'schema@probe.invalid', pw: 'not-a-password' }),
    }).catch(() => null);
    if (!res) return false;
    const body = await res.json().catch(() => ({}));
    return body?.code !== 'PGRST202';
}

async function waitFor(url, tries = 60) {
    for (let i = 0; i < tries; i++) {
        if (await up(url)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

function startApi(work) {
    const conf = join(work, 'postgrest.conf');
    const env = process.env;
    writeFileSync(conf, [
        `db-uri = "postgres://authenticator:${env.AUTHENTICATOR_PASSWORD ?? 'authenticator'}`
        + `@${env.PGHOST ?? 'localhost'}:${env.PGPORT ?? 5432}/${env.PGDATABASE ?? 'splatworld'}"`,
        'db-schemas = "api"', 'db-anon-role = "anon"',
        `jwt-secret = "${env.JWT_SECRET}"`, `server-port = ${API_PORT}`,
    ].join('\n'));
    const clean = { ...env };
    for (const k of Object.keys(clean)) if (k.startsWith('PGRST_')) delete clean[k];
    const p = spawn('postgrest', [conf], { env: clean, stdio: 'ignore' });
    return () => p.kill();
}

const haveBinary = (name) => spawnSync(name, ['-v'], { stdio: 'ignore' }).error === undefined;

// The other file store: the `splatworld` server in server/, which holds the
// same contract and passes nginx's own gate (tools/files-test.sh, Invariant 10).
// It is what runs on a machine with no nginx — a Windows box, and this one. It
// supervises PostgREST itself, so it replaces both processes rather than one.
function startPythonStack() {
    const p = spawn('splatworld',
        ['run', '--port', String(FILES_PORT), '--api-port', String(API_PORT), '--no-browser'],
        { env: { ...process.env, FILES_ROOT }, stdio: 'ignore' });
    return () => p.kill();
}

// The compose nginx.conf, retargeted at this box — the same file the deployment
// uses, so the test exercises the real auth_request and the real 409.
function startFiles(work) {
    const conf = join(work, 'nginx.conf');
    const body = readFileSync(join(REPO, 'infra/nginx.conf'), 'utf8')
        .replace('server postgrest:3000;', `server 127.0.0.1:${API_PORT};`)
        .replace('listen 80;', `listen ${FILES_PORT};`)
        .replace('root /srv/files;', `root ${FILES_ROOT};`)
        .replace('http {', `http {\n    access_log ${join(work, 'access.log')};\n`
            + `    client_body_temp_path ${join(work, 'body')};\n`
            + `    proxy_temp_path ${join(work, 'proxy')};\n`
            + `    fastcgi_temp_path ${join(work, 'fcgi')};\n`
            + `    uwsgi_temp_path ${join(work, 'uwsgi')};\n`
            + `    scgi_temp_path ${join(work, 'scgi')};`);
    writeFileSync(conf, `pid ${join(work, 'nginx.pid')};\n`
        + `error_log ${join(work, 'error.log')};\n${body}`);
    spawn('nginx', ['-c', conf], { stdio: 'ignore' });
    return () => spawn('nginx', ['-c', conf, '-s', 'quit'], { stdio: 'ignore' });
}

// client/ as static files, which is all it is meant to be.
function startClient() {
    const server = createServer((req, res) => {
        const p = join(CLIENT, new URL(req.url, 'http://x').pathname);
        if (!existsSync(p) || p.endsWith('/')) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' });
        res.end(readFileSync(p));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port, stop: () => server.close(),
        }));
    });
}

// The same reasoning as the work directory, for the store itself: a PUT is a
// rename() into the tile's or asset's directory, and nginx's worker is not
// whoever ran the test. A root-owned 0755 `infra/files/assets` turns every
// upload into a 500 that reads like a broken file store — tools/files-test.sh
// never sees it because it roots its own store in a 1777 temp directory.
function openToNginx() {
    mkdirSync(FILES_ROOT, { recursive: true });
    for (const dir of ['', 'assets', 'tiles', 'jobs', 'geo']) {
        const path = dir ? join(FILES_ROOT, dir) : FILES_ROOT;
        mkdirSync(path, { recursive: true });
        try { chmodSync(path, 0o1777); } catch { /* not ours to chmod: let it fail loudly */ }
    }
}

export async function startServices() {
    const work = mkdtempSync(join(tmpdir(), 'splatworld-e2e-'));
    // nginx's workers do not run as whoever started it, and mkdtemp is 0700:
    // without this the body temp files land nowhere and a PUT is a 500.
    chmodSync(work, 0o777);
    openToNginx();
    const stops = [];
    if (haveBinary('nginx')) {
        if (!await up(`http://localhost:${API_PORT}/`)) {
            stops.push(startApi(work));
        } else if (!await knowsTheSchema(`http://localhost:${API_PORT}`)) {
            throw new Error(`a PostgREST on ${API_PORT} is serving another database's`
                + ' schema — it was started before the last `make db-reset`. Restart it'
                + ' (or kill it and let the suite start its own).');
        }
        if (!await up(`http://localhost:${FILES_PORT}/healthz`)) stops.push(startFiles(work));
    } else if (!await up(`http://localhost:${FILES_PORT}/healthz`)) {
        stops.push(startPythonStack());
    }
    const client = await startClient();
    stops.push(client.stop);

    const ok = await waitFor(`http://localhost:${API_PORT}/`)
        && await waitFor(`http://localhost:${FILES_PORT}/healthz`);
    return {
        ok,
        apiUrl: `http://localhost:${API_PORT}`,
        filesUrl: `http://localhost:${FILES_PORT}`,
        baseUrl: `http://localhost:${client.port}`,
        pageUrl: `http://localhost:${client.port}/play.html`,
        stop: () => stops.forEach((s) => s()),
    };
}
