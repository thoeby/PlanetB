// The world a player-run happens in: an empty database, an empty file store,
// the server, and a GeoServer publishing one DEM. Nothing else is prepared —
// no ground is cut, no account exists, no land is drawn. Story 1 does all of
// that through the page, which is the point.
//
// PLAYER-RUN.md, "The harness": fixtures may only provide what the player is
// given. Everything here is a running process or a file on disk.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SEED_DEM = join(REPO, 'infra/seed/dem-visp.tif');
export const FILES_ROOT = join(REPO, 'infra/files');

const PORT = Number(process.env.RUN_PORT ?? 8080);
const API_PORT = Number(process.env.RUN_API_PORT ?? 3000);
const GS_PORT = Number(process.env.RUN_GEOSERVER_PORT ?? 8081);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, {
    cwd: REPO, encoding: 'utf8', ...opts,
});

const reachable = async (url) => fetch(url)
    .then((r) => r.ok || r.status === 404).catch(() => false);

async function waitFor(url, seconds, what) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
        if (await reachable(url)) return;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the world did not come up: ${what} (${url})`);
}

// PostgREST caches the schema at startup. One left running across a db-reset
// answers PGRST202 to every RPC, which reads in the page as a broken sign-in.
async function knowsTheSchema(apiUrl) {
    const res = await fetch(`${apiUrl}/rpc/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'schema@probe.invalid', pw: 'not-a-password' }),
    }).catch(() => null);
    if (!res) return false;
    return (await res.json().catch(() => ({})))?.code !== 'PGRST202';
}

function emptyDatabase() {
    const done = sh('make', ['db-reset'], { stdio: 'pipe' });
    if (done.status !== 0) {
        throw new Error(`make db-reset failed:\n${done.stderr || done.stdout}`);
    }
}

// nginx is not in this stack, but the server's own store still has to be
// writable by whoever the page's uploads arrive as.
function emptyStore() {
    rmSync(FILES_ROOT, { recursive: true, force: true });
    for (const dir of ['', 'assets', 'tiles', 'jobs', 'geo']) {
        const path = dir ? join(FILES_ROOT, dir) : FILES_ROOT;
        mkdirSync(path, { recursive: true });
        try { chmodSync(path, 0o1777); } catch { /* not ours: let a write fail loudly */ }
    }
}

function seedDem() {
    if (existsSync(SEED_DEM)) return;
    const cut = sh('bash', ['tools/make-seed-dem.sh'], { stdio: 'pipe' });
    if (cut.status !== 0) {
        throw new Error('tools/make-seed-dem.sh could not cut the seed DEM:\n'
            + `${cut.stderr || cut.stdout}`);
    }
}

// The GeoServer the operator is given. In order: one they are already running
// (RUN_GEOSERVER_URL), the container from infra/compose.yml, and — where no
// container registry is reachable — tools/geoserver-fixture.py over the same
// file. Which one it was is printed, because a story that passed against the
// fixture has only passed against the fixture.
async function startGeoServer() {
    if (process.env.RUN_GEOSERVER_URL) {
        const url = process.env.RUN_GEOSERVER_URL;
        await waitFor(`${url}/wcs?service=WCS&version=1.0.0&request=GetCapabilities`,
            30, 'the GeoServer you pointed RUN_GEOSERVER_URL at');
        return { url, kind: 'yours', stop: () => {} };
    }
    if (process.env.RUN_GEOSERVER !== 'fixture' && sh('docker', ['info']).status === 0
        && sh('docker', ['compose', '-f', 'infra/compose.yml', '--project-directory', '.',
            'pull', '-q', 'geoserver']).status === 0) {
        sh('docker', ['compose', '-f', 'infra/compose.yml', '--project-directory', '.',
            'up', '-d', 'geoserver']);
        const url = 'http://127.0.0.1:8081/geoserver';
        await waitFor(`${url}/wcs?service=WCS&version=1.0.0&request=GetCapabilities`,
            300, 'the GeoServer container');
        return {
            url,
            kind: 'container',
            stop: () => sh('docker', ['compose', '-f', 'infra/compose.yml',
                '--project-directory', '.', 'stop', 'geoserver']),
        };
    }
    const p = spawn('python3', ['tools/geoserver-fixture.py',
        '--tif', SEED_DEM, '--port', String(GS_PORT)], { cwd: REPO, stdio: 'ignore' });
    const url = `http://127.0.0.1:${GS_PORT}/geoserver`;
    await waitFor(`${url}/wcs?service=WCS&version=1.0.0&request=GetCapabilities`,
        30, 'tools/geoserver-fixture.py');
    return { url, kind: 'fixture', stop: () => p.kill() };
}

// The server supervises PostgREST, so killing it alone leaves an API behind
// that the next run then collides with — and the collision surfaces as "the
// world did not come up" with nothing to read. Its own group, its own log.
export const SERVER_LOG = join(REPO, 'test-results/run/server.log');

function startServer() {
    mkdirSync(dirname(SERVER_LOG), { recursive: true });
    const out = openSync(SERVER_LOG, 'w');
    const p = spawn('splatworld',
        ['run', '--port', String(PORT), '--api-port', String(API_PORT), '--no-browser'],
        { cwd: REPO, env: { ...process.env, FILES_ROOT }, detached: true,
            stdio: ['ignore', out, out] });
    return () => { try { process.kill(-p.pid); } catch { p.kill(); } };
}

function whatTheServerSaid() {
    try {
        return `\n  it said:\n${readFileSync(SERVER_LOG, 'utf8').trim()}`;
    } catch {
        return '';
    }
}

export async function startWorld() {
    seedDem();
    emptyDatabase();
    emptyStore();
    const stops = [];
    const geoserver = await startGeoServer();
    stops.push(geoserver.stop);
    stops.push(startServer());
    const apiUrl = `http://localhost:${API_PORT}`;
    try {
        await waitFor(`http://localhost:${PORT}/healthz`, 60, 'the splatworld server');
        await waitFor(apiUrl, 60, 'PostgREST');
    } catch (err) {
        stops.forEach((s) => s());
        throw new Error(err.message + whatTheServerSaid());
    }
    if (!await knowsTheSchema(apiUrl)) {
        throw new Error(`a PostgREST on ${API_PORT} is serving another database's schema`
            + ' — it was started before this run reset the database. Kill it.');
    }
    return {
        apiUrl,
        filesUrl: `http://localhost:${PORT}`,
        // localhost, not a made-up hostname: WebCrypto and the Cache API are
        // not there at all on an origin the browser does not call secure.
        pageUrl: `http://localhost:${PORT}/app/play.html`,
        geoserverUrl: geoserver.url,
        geoserverKind: geoserver.kind,
        stop: () => stops.forEach((s) => s()),
    };
}
