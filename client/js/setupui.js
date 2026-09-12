// setupui.js — the Setup panel: your account, your GeoServer, and the ground
// the world stands on.
//
// Three things, once, in the order they depend on each other. The account comes
// from auth.js above this; here is the GeoServer and the coverage its WCS
// publishes, which is the world's ground (TASKS-usable T0). Picking it is the
// last thing anybody has to do before there is somewhere to stand.
//
// The /setup/ endpoints are the local server's and answer only a browser on the
// same machine; storing the choice is an ordinary RPC, so it goes through
// PostgREST like every other write and the database decides who may (T0, §6).

import * as api from './api.js';

const HTML = `
<label>GeoServer address</label>
<input class="gs-url" type="text" placeholder="localhost:8080/geoserver" autocomplete="off">
<div class="row">
  <input class="gs-user" type="text" placeholder="admin" autocomplete="off">
  <input class="gs-pw" type="password" placeholder="password" autocomplete="off">
</div>
<div class="row">
  <button type="button" class="gs-connect primary">Connect</button>
</div>
<p class="gs-status status"></p>
<label>Ground</label>
<select class="gs-coverage"><option value="">connect first</option></select>
<div class="row">
  <button type="button" class="gs-done" disabled>Done</button>
</div>
<p class="gs-ground status"></p>`;

const post = async (path, body) => {
    const res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
};

const bbox = (c) => (Array.isArray(c.bbox) && c.bbox.length === 4 ? c.bbox : null);

// GeoServer answers a refused REST call with a page of HTML, and the whole of
// it in a status line is worse than none of it. The first few lines carry what
// went wrong; the rest is in the terminal.
const short = (text) => String(text ?? '').split('\n').filter((l) => l.trim())
    .slice(0, 3).join(' ').slice(0, 240);

const describe = (g) => (g?.coverage
    ? `${g.coverage} — ${g.west.toFixed(2)},${g.south.toFixed(2)} to `
      + `${g.east.toFixed(2)},${g.north.toFixed(2)}`
    : 'no ground yet: the world has nowhere to be');

// One button: prove the address and the login, set the world's drawing layers
// up on it, then ask what it publishes. Setting up is several REST calls and is
// safe to repeat — a missing layer is made, one in an old store is moved, one
// the world no longer has is removed. Nothing about the ground is saved until
// Done; the credentials are, because the local server cuts elevation with them.
async function connect(q, say) {
    const url = q('.gs-url').value.trim();
    if (!url) { say('.gs-status', 'type the address your GeoServer opens on', true); return []; }
    const user = q('.gs-user').value.trim() || 'admin';
    const password = q('.gs-pw').value;
    say('.gs-status', 'setting your GeoServer up\u2026 (this takes a moment)');
    const test = await post('/setup/geoserver', { url, user, password, provision: true })
        .catch((err) => ({ ok: false, error: String(err.message ?? err) }));
    if (!test.ok) { say('.gs-status', short(test.error) || 'that did not work', true); return []; }
    say('.gs-status', 'set up \u2014 asking what it publishes\u2026');
    const probe = await post('/setup/probe', { url, user, password })
        .catch((err) => ({ error: String(err.message ?? err) }));
    if (probe.error) { say('.gs-status', short(probe.error), true); return []; }
    const found = (probe.coverages ?? []).filter(bbox);
    const select = q('.gs-coverage');
    select.replaceChildren(...(found.length
        ? found.map((c) => new Option(`${c.title} (${c.id})`, c.id))
        : [new Option('this GeoServer publishes no raster with an extent', '')]));
    q('.gs-done').disabled = !found.length;
    say('.gs-status', found.length
        ? `${found.length} coverage(s) \u2014 pick the elevation and press Done`
        : 'connected, but there is no coverage to stand on', !found.length);
    return found;
}

export function mountSetup(host, { onGround = () => {} } = {}) {
    const box = document.createElement('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (sel, msg, bad = false) => {
        const node = q(sel);
        node.textContent = msg;
        node.dataset.bad = bad ? '1' : '';
    };

    let found = [];

    async function show() {
        const g = await api.rpc('ground').catch(() => null);
        say('.gs-ground', describe(g));
        if (g?.geoserver_url && !q('.gs-url').value) q('.gs-url').value = g.geoserver_url;
        return g;
    }

    // The world's ground. set_ground is an RPC, so an install with somebody
    // else's world already on it refuses this unless you are an admin.
    async function done() {
        const chosen = found.find((c) => c.id === q('.gs-coverage').value);
        if (!chosen) return;
        const [west, south, east, north] = bbox(chosen);
        q('.gs-done').disabled = true;
        try {
            const out = await api.rpc('set_ground', {
                url: q('.gs-url').value.trim(), coverage: chosen.id,
                west, south, east, north,
            });
            const g = await show();
            say('.gs-status', out?.dirtied
                ? `ground set — ${out.dirtied} compiled tile(s) will be built again`
                : 'ground set');
            onGround(g);
        } catch (err) {
            say('.gs-status', String(err.body?.message ?? err.message ?? err), true);
        } finally {
            q('.gs-done').disabled = false;
        }
    }

    q('.gs-connect').onclick = () => connect(q, say).then((c) => { found = c; }).catch(
        (err) => say('.gs-status', String(err.message ?? err), true));
    q('.gs-done').onclick = () => done();

    show();
    return { refresh: show, done,
        connect: () => connect(q, say).then((c) => { found = c; }) };
}
