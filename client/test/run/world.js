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
import { startProcessServers } from './elx.js';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SEED_DEM = join(REPO, 'infra/seed/dem-visp.tif');
export const FILES_ROOT = join(REPO, 'infra/files');

const PORT = Number(process.env.RUN_PORT ?? 8081);
const API_PORT = Number(process.env.RUN_API_PORT ?? 3000);
const GS_PORT = Number(process.env.RUN_GEOSERVER_PORT ?? 8083);

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
    // An answer that is not JSON at all is PostgREST with no database behind
    // it — "Something went wrong", which one left running across a db-reset
    // says to everything. Reading that as "fine" is how a whole run failed at
    // its first assertion with nothing to read.
    const said = await res.text();
    try {
        return JSON.parse(said)?.code !== 'PGRST202';
    } catch {
        return false;
    }
}

// How big the world this run builds is. Every tile is trained since the
// sampler was removed, and a z14 tile at the operator's own numbers — 800 000
// splats, 1 200 iterations, 1 024 px — is hours on a software adapter and
// minutes on a GPU. The stories are about what a player does, not about how
// many splats it takes, so the run turns the three numbers db/0131 exposes
// down to a twentieth. The operator's world is untouched: unset, they are what
// they always were. RUN_FULL_SIZE=1 renders at the real size.
const SMALL = ['budget_scale', '0.05'], ITERS = ['iters', '60'],
    PX = ['frame_px', '192'],
    // The ground from the tile's own cut (db/0199): a z14 tile cut from z16
    // is a mesh of eight million triangles, past what a tab on a software
    // adapter holds while it frames it.
    DEEPER = ['dem_deeper', '0'],
    // How long a claim is left alone after its tab stops beating (db/0132).
    // Story 13 watches a render somebody walked away from come back, and five
    // minutes of watching is not a story. It cannot go below the minute the
    // tab beats at (client/js/work.js HEARTBEAT_MS), or the world takes work
    // away from a tab that is doing it.
    LEASE = ['lease', '150 seconds'];

function emptyDatabase() {
    const done = sh('make', ['db-reset'], { stdio: 'pipe' });
    if (done.status !== 0) {
        throw new Error(`make db-reset failed:\n${done.stderr || done.stdout}`);
    }
}

// ALTER DATABASE persists, and the database a run happens in is the
// operator's own. A run that set these and walked away left the world being
// built at a twentieth of the budget, sixty iterations and 192 px frames,
// with every claim leased for 150 seconds — for good, and with nothing on the
// page saying so. That is what "the claim went quiet and the world took the
// piece back" was, and what "it still looks not great" was: one run, months
// ago, and every tile since. So the run says what it found and puts it back
// (`undoSize`), and the world says out loud what it is built at (db/0173).
function alter(db, clause) {
    const done = sh('psql', ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-c',
        `ALTER DATABASE "${db}" ${clause}`], { stdio: 'pipe' });
    if (done.status !== 0) {
        throw new Error(`could not ${clause}:\n${done.stderr || done.stdout}`);
    }
}

// What this database already had for the four keys, as psql prints them in
// pg_db_role_setting: `splatworld.iters=60`. Anything else there is somebody
// else's and is not touched.
function sizeWas(db) {
    const got = sh('psql', ['-Atc',
        'SELECT unnest(setconfig) FROM pg_db_role_setting s'
        + ' JOIN pg_database d ON d.oid = s.setdatabase'
        + ` WHERE d.datname = '${db}' AND s.setrole = 0`], { stdio: 'pipe' });
    const had = new Map();
    for (const line of (got.stdout ?? '').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0 && line.startsWith('splatworld.')) {
            had.set(line.slice('splatworld.'.length, at), line.slice(at + 1));
        }
    }
    return had;
}

function runSize() {
    if (process.env.RUN_FULL_SIZE === '1') return () => {};
    const db = process.env.PGDATABASE ?? 'splatworld';
    const had = sizeWas(db);
    for (const [key, value] of [SMALL, ITERS, PX, DEEPER, LEASE]) {
        alter(db, `SET splatworld.${key} = '${value}'`);
    }
    return () => {
        for (const [key] of [SMALL, ITERS, PX, DEEPER, LEASE]) {
            alter(db, had.has(key)
                ? `SET splatworld.${key} = '${had.get(key)}'`
                : `RESET splatworld.${key}`);
        }
    };
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

// What a player is given besides the ground (TASKS-foundation.md FND.0): the
// OSM extract they load into their land, and the two ground-cover sources an
// admin maps. Cached like the DEM; a run without them skips the stories that
// need them rather than failing the ones that do not.
function seedFixtures() {
    for (const [file, script] of [
        ['infra/seed/osm-visp.gpkg', 'tools/make-seed-osm.sh'],
        ['infra/seed/worldcover-visp.tif', 'tools/make-seed-cover.sh'],
    ]) {
        if (existsSync(join(REPO, file))) continue;
        const made = sh('bash', [script], { stdio: 'pipe' });
        if (made.status !== 0) {
            process.stderr.write(`player-run: ${script} could not write ${file}; `
                + 'the stories that need it will say so\n'
                + `${made.stderr || made.stdout}\n`);
        }
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
        const url = 'http://127.0.0.1:8083/geoserver';
        await waitFor(`${url}/wcs?service=WCS&version=1.0.0&request=GetCapabilities`,
            300, 'the GeoServer container');
        return {
            url,
            kind: 'container',
            stop: () => sh('docker', ['compose', '-f', 'infra/compose.yml',
                '--project-directory', '.', 'stop', 'geoserver']),
        };
    }
    // The cover fixtures of TASKS-foundation.md FND.0 are published beside the
    // elevation, as the operator's own GeoServer publishes them: a story that
    // maps ground cover has two sources to map (FND.12).
    const covers = [];
    for (const [name, file, field] of [
        ['splatworld:tlm', 'infra/seed/tlm-visp.gpkg', 'OBJEKTART'],
        ['splatworld:worldcover', 'infra/seed/worldcover-visp.tif', ''],
    ]) {
        const path = join(REPO, file);
        if (existsSync(path)) covers.push('--cover', `${name}=${path}${field ? `:${field}` : ''}`);
    }
    const p = spawn('python3', ['tools/geoserver-fixture.py',
        '--tif', SEED_DEM, '--port', String(GS_PORT), ...covers],
    { cwd: REPO, stdio: 'ignore' });
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

// SPEC §3.12 and PLAYER-RUN story 13: the elevation service is stopped
// mid-run and started again. A story that wants it gone asks here rather than
// reaching for a process itself.
function switchable(started) {
    let live = started;
    return {
        get url() { return live.url; },
        get kind() { return live.kind; },
        stop() { live.stop(); },
        async start() { live = await startGeoServer(); return live.url; },
    };
}

// The cut ground the server has on disk, forgotten. It is the same thing
// `emptyStore` does at the start of a run: it says what the world has been
// given, not what a player did. A story that wants ground nobody has cut yet
// needs this, because four kilometres of DEM is a handful of tiles and the
// stories before it have walked over all of them.
function forgetGround() {
    rmSync(join(FILES_ROOT, 'geo'), { recursive: true, force: true });
    mkdirSync(join(FILES_ROOT, 'geo'), { recursive: true });
    try { chmodSync(join(FILES_ROOT, 'geo'), 0o1777); } catch { /* let a write fail */ }
}

// A run starts from an empty database and an empty store, always — that is
// the gate. RUN_KEEP_WORLD=1 is for the person writing a late story: with
// tools/replay.sh it puts back the world the stories before it left, so the
// one being written can be run again in minutes instead of an hour and a
// half. Nothing but a developer's own shell ever sets it.
const keepingTheWorld = () => process.env.RUN_KEEP_WORLD === '1';

export async function startWorld() {
    seedDem();
    seedFixtures();
    if (!keepingTheWorld()) {
        emptyDatabase();
        emptyStore();
    }
    const stops = [runSize()];
    const geoserver = switchable(await startGeoServer());
    stops.push(() => geoserver.stop());
    const elx = await startProcessServers();
    stops.push(() => elx.stop());
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
        stops.forEach((s) => s());
        throw new Error(`a PostgREST on ${API_PORT} does not know this database`
            + ' — it was left running across a db-reset by an earlier run.'
            + ' Kill it and start again.');
    }
    return {
        apiUrl,
        filesUrl: `http://localhost:${PORT}`,
        // localhost, not a made-up hostname: WebCrypto and the Cache API are
        // not there at all on an origin the browser does not call secure.
        pageUrl: `http://localhost:${PORT}/app/play.html`,
        geoserverUrl: geoserver.url,
        geoserverKind: geoserver.kind,
        geoserver,
        elx,
        forgetGround,
        stop: () => stops.forEach((s) => s()),
    };
}
