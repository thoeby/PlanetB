// The process servers a player-run is given (TASKS-flows.md, "The fixture").
//
// Two of tools/elx-fixture.py, `alpha` and `beta`, on ports of their own. They
// are what a player is handed — "a running server" (PLAYER-RUN.md) — and
// nothing a player does is done here. `alpha` offers one plugin the bundle
// does not have (fixtures/weather.xml), so FL.2 has something to learn from it.
// A story that passed against them has passed against the fixture only.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const PORTS = { alpha: Number(process.env.RUN_ALPHA_PORT ?? 8091),
    beta: Number(process.env.RUN_BETA_PORT ?? 8092),
    // gamma is like the real elx server: no CORS headers (docs/flow.md), and
    // the relay a player runs beside it (tools/elx-relay.py).
    gamma: Number(process.env.RUN_GAMMA_PORT ?? 8093) };
const RELAY_PORT = Number(process.env.RUN_RELAY_PORT ?? 8094);
// alpha also has the world's own plugin, as a server that runs World blocks
// does (design 10a: "World — alpha knows these blocks"), and the two built
// over it (LV.3); beta has none of them.
const EXTRA = { alpha: [join(REPO, 'client/test/run/fixtures/weather.xml'),
    ...['world', 'motion', 'interact'].map((p) => join(REPO, `client/flow/${p}/plugin.xml`))],
beta: [], gamma: [] };
// What alpha already has when it starts: one of the reference samples, which
// story 34 saves into a land and exports again.
export const SAMPLE = join(REPO, 'client/flow/samples/file-response.elx');
const PROCESSES = { alpha: [`file-response=${SAMPLE}`], beta: [], gamma: [] };

const answers = (url) => fetch(`${url}/api/v1/system/status`)
    .then((r) => r.ok).catch(() => false);

async function up(name) {
    const port = PORTS[name];
    const url = `http://127.0.0.1:${port}`;
    const args = [join(REPO, 'tools/elx-fixture.py'), '--port', String(port), '--name', name,
        '--plugins', join(REPO, 'client/flow/palette/plugins'),
        ...EXTRA[name].flatMap((f) => ['--extra', f]),
        ...PROCESSES[name].flatMap((p) => ['--process', p]),
        ...(name === 'gamma' ? ['--no-cors'] : [])];
    const p = spawn('python3', args, { cwd: REPO, stdio: 'ignore', detached: true });
    const until = Date.now() + 15_000;
    while (!(await answers(url))) {
        if (Date.now() > until) throw new Error(`the ${name} process server did not come up`);
        await new Promise((r) => setTimeout(r, 100));
    }
    return { url, stop: () => { try { process.kill(-p.pid); } catch { p.kill(); } } };
}

// One server that a story may stop and start again, as story 13 does with the
// GeoServer. Started again, it has forgotten everything, as a restarted
// in-memory server would.
async function switchable(name) {
    let live = await up(name);
    return {
        name,
        get url() { return live.url; },
        stop() { live.stop(); },
        async start() { live = await up(name); return live.url; },
        // What the world answered this server's runs (elx-fixture.py
        // /__fixture/calls), and one more run of a job the page has deleted —
        // what a server that kept a stale job would do.
        calls: () => fetch(`${live.url}/__fixture/calls`).then((r) => r.json()),
        replay: (job) => fetch(`${live.url}/__fixture/replay?job=${encodeURIComponent(job)}`,
            { method: 'POST' }).then((r) => r.json()),
    };
}

// The relay a player runs beside a server that sends no CORS headers.
async function relayTo(url) {
    const p = spawn('python3', [join(REPO, 'tools/elx-relay.py'), '--to', url,
        '--port', String(RELAY_PORT)], { cwd: REPO, stdio: 'ignore', detached: true });
    const at = `http://127.0.0.1:${RELAY_PORT}`;
    const until = Date.now() + 15_000;
    while (!(await answers(at))) {
        if (Date.now() > until) throw new Error('the relay did not come up');
        await new Promise((r) => setTimeout(r, 100));
    }
    return { url: at, stop: () => { try { process.kill(-p.pid); } catch { p.kill(); } } };
}

export async function startProcessServers() {
    const alpha = await switchable('alpha');
    const beta = await switchable('beta');
    const gamma = await up('gamma');
    const relay = await relayTo(gamma.url);
    return { alpha, beta, gamma, relay,
        stop: () => { alpha.stop(); beta.stop(); gamma.stop(); relay.stop(); } };
}
