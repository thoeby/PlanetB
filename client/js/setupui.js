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
import { el } from './chrome.js';

// Design 3k: three numbered steps, in the order they have to happen. Step 1
// is the account, and client/js/auth.js mounts its form into the slot below —
// the order on the screen is the order of the work, so the step that has to
// come first is drawn first rather than wherever it happened to be mounted.
const HTML = `
<div class="step gs-step1" data-now="1">
  <span class="n">1</span>
  <div class="t">
    <span class="head">Account</span>
    <div class="note">Who you are in this world. Everything you draw, place or
      are paid for belongs to this account.</div>
    <div class="gs-account"></div>
  </div>
</div>
<div class="step gs-step2">
  <span class="n">2</span>
  <div class="t">
    <span class="head">GeoServer</span>
    <div class="note">The GeoServer that publishes your elevation. Nothing
      else is asked of it.</div>
    <input class="gs-url" type="text" placeholder="localhost:8080/geoserver"
      autocomplete="off">
    <div class="row">
      <input class="gs-user" type="text" placeholder="admin" autocomplete="off">
      <input class="gs-pw" type="password" placeholder="password" autocomplete="off">
      <button type="button" class="gs-connect primary">Connect</button>
    </div>
    <p class="gs-status status"></p>
  </div>
</div>
<div class="step gs-step3">
  <span class="n">3</span>
  <div class="t">
    <span class="head">Ground</span>
    <div class="note">The coverage the world stands on. Everything outside it
      is off the edge of the world.</div>
    <select class="gs-coverage"><option value="">connect first</option></select>
    <div class="row">
      <button type="button" class="gs-done" disabled>Use this ground</button>
      <button type="button" class="gs-recut" title="The survey behind this
        coverage changed">Cut the ground again</button>
      <button type="button" class="gs-again">Render the whole ground again</button>
      <button type="button" class="gs-frames">Draw every frame again</button>
    </div>
    <p class="gs-ground status"></p>
    <div class="note">More of the ground: another elevation over or under
      this one, an orthophoto for the ground's colour, a shade to lay over it.
      Cut the ground again after changing these, then render again.</div>
    <div class="row">
      <select class="gs-lkind"><option value="dem">elevation</option>
        <option value="albedo">albedo</option><option value="shade">shade</option></select>
      <select class="gs-llayer"><option value="">connect first</option></select>
      <input class="gs-lprio" type="number" value="0" title="priority" style="width:4em">
      <button type="button" class="gs-ladd">Add layer</button>
    </div>
    <ul class="gs-layers"></ul>
    <p class="gs-drawer note"></p>
  </div>
</div>`;

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

// One button: prove the address and the login against the service the world
// actually reads — the WCS — and ask what it publishes. Nothing is asked of
// this GeoServer but the elevation (SPEC §3.1), so nothing is created on it.
// Nothing about the ground is saved until Done; the credentials are, because
// the local server cuts elevation with them.
async function connect(q, say) {
    const url = q('.gs-url').value.trim();
    if (!url) { say('.gs-status', 'type the address your GeoServer opens on', true); return []; }
    const user = q('.gs-user').value.trim() || 'admin';
    const password = q('.gs-pw').value;
    say('.gs-status', 'asking that GeoServer what it publishes\u2026');
    const test = await post('/setup/geoserver', { url, user, password, provision: false })
        .catch((err) => ({ ok: false, error: String(err.message ?? err) }));
    if (!test.ok) { say('.gs-status', short(test.error) || 'that did not work', true); return []; }
    say('.gs-status', 'reached \u2014 reading its coverages\u2026');
    const probe = await post('/setup/probe', { url, user, password })
        .catch((err) => ({ error: String(err.message ?? err) }));
    if (probe.error) { say('.gs-status', short(probe.error), true); return []; }
    const found = (probe.coverages ?? []).filter(bbox);
    const select = q('.gs-coverage');
    select.replaceChildren(...(found.length
        ? found.map((c) => new Option(`${c.title} (${c.id})`, c.id))
        : [new Option('this GeoServer publishes no raster with an extent', '')]));
    q('.gs-done').disabled = !found.length;
    // The button says "Use this ground"; telling somebody to press Done sends
    // them looking for a button that is not there.
    say('.gs-status', found.length
        ? `${found.length} coverage(s) \u2014 pick the elevation and press`
          + ' "Use this ground"'
        : 'connected, but there is no coverage to stand on', !found.length);
    return found;
}

// Whose land it becomes when somebody draws in QGIS. GeoServer connects as
// one database role and carries no person, so the world has to answer this for
// itself (db/0058) — and say so, because getting it wrong is invisible: the
// land is saved, to somebody else, and Your land is empty.
async function sayWhoDraws(say) {
    const who = await api.rpc('drawing_as').catch(() => null);
    if (!who?.email) {
        say('.gs-drawer', 'Nobody can own what is drawn yet — create an'
            + ' account above first.', true);
        return;
    }
    say('.gs-drawer', who.from_ground
        ? `What you draw in QGIS belongs to ${who.email}, who set this ground.`
        : `What you draw in QGIS would belong to ${who.email} — the oldest`
          + ' admin account, because no ground is set yet. Pick a ground and'
          + ' it becomes yours.', !who.from_ground);
}

// A step that is finished says so, and the one to do next is marked, so the
// panel reads as a route rather than three forms.
function markSteps(q, g) {
    const signedIn = Boolean(api.claims());
    const at = {
        '.gs-step1': [signedIn, !signedIn],
        '.gs-step2': [Boolean(g?.geoserver_url), signedIn && !g?.geoserver_url],
        '.gs-step3': [Boolean(g?.coverage),
            signedIn && Boolean(g?.geoserver_url) && !g?.coverage],
    };
    for (const [sel, [done, now]] of Object.entries(at)) {
        q(sel).dataset.done = done ? '1' : '';
        q(sel).dataset.now = now ? '1' : '';
    }
}

// Every open job there is, drawing its views again and training on the new
// ones (db/0149). The elevation changed under tiles that were already framed
// — a layer added, a cut that has since been fixed — and their frames are of
// the old ground. Nothing is compiled from scratch and no version moves.
async function frames(q, say) {
    q('.gs-frames').disabled = true;
    say('.gs-ground', 'asking every open tile for its frames again\u2026');
    try {
        const n = await api.rpc('redo_ground_renders', {});
        say('.gs-ground', n
            ? `${n} tile(s) will draw their views again, and train on them`
            : 'no open tile has frames of its own to draw again');
    } catch (err) {
        say('.gs-ground', `could not: ${String(err.body?.message ?? err.message ?? err)}`, true);
        console.error(err);
    } finally {
        q('.gs-frames').disabled = false;
    }
}

// Every z14 tile of the ground, built again from what is on it now
// (db/0104_thewholeground.sql): what to press when the recipe changed.
async function again(q, say) {
    q('.gs-again').disabled = true;
    say('.gs-ground', 'asking the world to render its ground\u2026');
    try {
        const n = await api.rpc('compile_ground', {});
        say('.gs-ground', `${n} tile(s) of ground to render \u2014 see Render jobs`);
    } catch (err) {
        say('.gs-ground', `could not: ${String(err.body?.message ?? err.message ?? err)}`, true);
        console.error(err);
    } finally {
        q('.gs-again').disabled = false;
    }
}

// The same coverage, a new survey behind it (db/0154 recut_ground): every cut
// the store has is of the old one and every tab is holding copies it was told
// to keep for a year. This forgets them all; the maps ask again as they are
// drawn. What is already compiled is left alone — that is the button beside
// this one.
async function recut(q, say, onRecut) {
    q('.gs-recut').disabled = true;
    say('.gs-ground', 'forgetting every cut of the ground\u2026');
    try {
        const out = await api.rpc('recut_ground', {});
        const g = await api.rpc('ground').catch(() => null);
        say('.gs-ground', `${out?.forgotten ?? 0} cut tile(s) forgotten \u2014 the`
            + ' ground is cut again as it is asked for');
        // The mark the RPC answered with, not whatever a second read happens
        // to see: it is what every cut is now asked for under.
        onRecut({ ...(g ?? {}), set_at: out?.cut_at ?? g?.set_at ?? '' });
    } catch (err) {
        say('.gs-ground', `could not: ${String(err.body?.message ?? err.message ?? err)}`,
            true);
    } finally {
        q('.gs-recut').disabled = false;
    }
}

// The ground's layers (db/0106): what there is, and a way to take one out.
function listLayers(q, g, refresh) {
    const items = (g?.layers ?? []).map((l) => {
        const gone = el('button', { type: 'button', textContent: 'Remove' });
        gone.onclick = () => api.rpc('drop_ground_layer', { id: l.id }).then(refresh);
        return el('li', {}, `${l.kind} \u00b7 ${l.layer} \u00b7 priority ${l.priority} `, gone);
    });
    q('.gs-layers').replaceChildren(...items);
}

async function addLayer(q, say, found, refresh) {
    const chosen = found.find((c) => c.id === q('.gs-llayer').value);
    const box = chosen && bbox(chosen);
    if (!box) { say('.gs-ground', 'connect and pick a layer first', true); return; }
    const [west, south, east, north] = box;
    try {
        await api.rpc('set_ground_layer', {
            kind: q('.gs-lkind').value, url: q('.gs-url').value.trim(), layer: chosen.id,
            west, south, east, north, priority: Number(q('.gs-lprio').value) || 0,
        });
        await refresh();
    } catch (err) {
        say('.gs-ground', String(err.body?.message ?? err.message ?? err), true);
    }
}

export function mountSetup(host, { onGround = () => {}, onRecut = () => {} } = {}) {
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
        listLayers(q, g, show);
        markSteps(q, g);
        if (g?.geoserver_url && !q('.gs-url').value) q('.gs-url').value = g.geoserver_url;
        await sayWhoDraws(say);
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
                ? `ground set — ${out.dirtied} tile(s) of it are being rendered`
                : 'ground set');
            onGround(g);
        } catch (err) {
            say('.gs-status', String(err.body?.message ?? err.message ?? err), true);
        } finally {
            q('.gs-done').disabled = false;
        }
    }

    q('.gs-connect').onclick = () => connect(q, say).then((c) => {
        found = c;
        q('.gs-llayer').replaceChildren(...c.map((l) => new Option(l.title, l.id)));
    }).catch((err) => say('.gs-status', String(err.message ?? err), true));
    q('.gs-recut').onclick = () => recut(q, say, onRecut);
    q('.gs-ladd').onclick = () => addLayer(q, say, found, show);
    q('.gs-done').onclick = () => done();
    q('.gs-again').onclick = () => again(q, say);
    q('.gs-frames').onclick = () => frames(q, say);

    show();
    // Where client/play.html mounts the sign-in form, so step 1 is a step
    // rather than a form at the bottom of the panel.
    return { refresh: show, done, account: q('.gs-account'),
        connect: () => connect(q, say).then((c) => { found = c; }) };
}
