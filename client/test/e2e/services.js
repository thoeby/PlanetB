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
    '.sog': 'application/octet-stream', '.webp': 'image/webp',
};

const up = async (url) => fetch(url).then((r) => r.ok || r.status === 404).catch(() => false);

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
    mkdirSync(FILES_ROOT, { recursive: true });
    const p = spawn('splatworld',
        ['run', '--port', String(FILES_PORT), '--api-port', String(API_PORT), '--no-browser'],
        { env: { ...process.env, FILES_ROOT }, stdio: 'ignore' });
    return () => p.kill();
}

// The compose nginx.conf, retargeted at this box — the same file the deployment
// uses, so the test exercises the real auth_request and the real 409.
function startFiles(work) {
    const conf = join(work, 'nginx.conf');
    mkdirSync(FILES_ROOT, { recursive: true });
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

export async function startServices() {
    const work = mkdtempSync(join(tmpdir(), 'splatworld-e2e-'));
    // nginx's workers do not run as whoever started it, and mkdtemp is 0700:
    // without this the body temp files land nowhere and a PUT is a 500.
    chmodSync(work, 0o777);
    const stops = [];
    if (haveBinary('nginx')) {
        if (!await up(`http://localhost:${API_PORT}/`)) stops.push(startApi(work));
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
