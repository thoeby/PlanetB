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
import { frames, recut } from './setupground.js';
import { convertAll, oldShapes } from './oldshapes.js';
import { el } from './chrome.js';
import { bundledPlugins, bundlePlugins } from './flows.js';
import { checkingServer, setCheckingServer } from './flowcheck.js';

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
    <input class="gs-url" type="text" placeholder="localhost:8083/geoserver"
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
    <!-- FND.11: the shapes that used to move the ground, while any are left.
         Converting them is a tab's work, not the world's (Invariant 9). -->
    <div class="gs-old" hidden>
      <p class="gs-old-said status"></p>
      <button type="button" class="gs-old-go">Convert</button>
    </div>
    <p class="gs-drawer note"></p>
  </div>
</div>
<div class="step gs-step4">
  <span class="n">4</span>
  <div class="t">
    <span class="head">Blocks</span>
    <div class="note">The blocks flows are drawn with (Automate). They ship
      with the page; this tells the world which set it saw, so a flow drawn
      against one can still be read against another.</div>
    <button type="button" class="gs-blocks">Register the bundled blocks</button>
    <p class="gs-blocks-status status"></p>
    <div class="note">A process server can be asked whether a flow is one it
      would run (Automate → Validate). Leave this empty and the page still
      checks what it can see for itself.</div>
    <div class="row">
      <input class="gs-elx" type="text" placeholder="http://localhost:8088"
        autocomplete="off">
      <button type="button" class="gs-elx-save">Use this server</button>
    </div>
    <p class="gs-elx-status status"></p>
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
    const test = await post('/setup/geoserver', { url, user, password })
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


// FND.11: how many old terrain-edit shapes are left, and the button that
// turns them into the grid that moves the ground now (client/js/oldshapes.js).
async function showOldShapes(q, say) {
    const said = await oldShapes();
    const n = Number(said?.shapes ?? 0);
    q('.gs-old').hidden = !n;
    if (!n) return;
    const lands = (said.lands ?? []).length;
    say('.gs-old-said', `Old terrain edits: ${n} on ${lands}`
        + ` land${lands === 1 ? '' : 's'} \u2014 convert`);
}

// Every button of the panel, once.
function wireSetup(q, say, { show, done, layers, onRecut }) {
    q('.gs-connect').onclick = () => connect(q, say).then((c) => {
        layers.found = c;
        q('.gs-llayer').replaceChildren(...c.map((l) => new Option(l.title, l.id)));
    }).catch((err) => say('.gs-status', String(err.message ?? err), true));
    q('.gs-ladd').onclick = () => addLayer(q, say, layers.found, show);
    q('.gs-blocks').onclick = () => registerBlocks(q, say);
    wireCheckingServer(q, say);
    q('.gs-recut').onclick = () => recut(q, say, onRecut);
    q('.gs-done').onclick = () => done();
    q('.gs-again').onclick = () => again(q, say);
    q('.gs-frames').onclick = () => frames(q, say);
    q('.gs-old-go').onclick = () => convertOld(q, say, show);
}

async function convertOld(q, say, show) {
    q('.gs-old-go').disabled = true;
    say('.gs-old-said', 'converting\u2026');
    try {
        const got = await convertAll();
        say('.gs-old-said', `converted ${got.shapes} shape(s) on ${got.lands}`
            + ` land${got.lands === 1 ? '' : 's'}`);
        await show();
    } catch (err) {
        say('.gs-old-said', String(err.body?.message ?? err.message ?? err), true);
    } finally {
        q('.gs-old-go').disabled = false;
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

// db/0155 elx_plugin: the bundled XMLs, stored and named. Run once, and again
// when one of them has changed — the hashes decide, so running it twice over
// the same set writes the same rows.
async function registerBlocks(q, say) {
    q('.gs-blocks').disabled = true;
    say('.gs-blocks-status', 'reading the bundled blocks\u2026');
    try {
        const n = await bundlePlugins(await bundledPlugins());
        say('.gs-blocks-status', `${n} plugin(s) registered`);
    } catch (err) {
        say('.gs-blocks-status', String(err.body?.message ?? err.message ?? err), true);
    } finally {
        q('.gs-blocks').disabled = false;
    }
}

// Where a flow may be checked (db/0156). Empty is a choice, not a gap: the
// page still checks what it can see for itself.
function wireCheckingServer(q, say) {
    const words = (url) => (url ? `flows are checked against ${url}`
        : 'no process server \u2014 flows are checked here only');
    q('.gs-elx-save').onclick = async () => {
        try {
            say('.gs-elx-status', words(await setCheckingServer(q('.gs-elx').value.trim())));
        } catch (err) {
            say('.gs-elx-status', String(err.body?.message ?? err.message ?? err), true);
        }
    };
    checkingServer().then((url) => {
        q('.gs-elx').value = url;
        say('.gs-elx-status', words(url));
    });
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

    // What the GeoServer said it publishes, once it has been asked.
    const layers = { found: [] };

    async function show() {
        const g = await api.rpc('ground').catch(() => null);
        say('.gs-ground', describe(g));
        await showOldShapes(q, say);
        listLayers(q, g, show);
        markSteps(q, g);
        if (g?.geoserver_url && !q('.gs-url').value) q('.gs-url').value = g.geoserver_url;
        await sayWhoDraws(say);
        return g;
    }

    // The world's ground. set_ground is an RPC, so an install with somebody
    // else's world already on it refuses this unless you are an admin.
    async function done() {
        const chosen = layers.found.find((c) => c.id === q('.gs-coverage').value);
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

    wireSetup(q, say, { show, done, layers, onRecut });

    show();
    // Where client/js/play.js mounts the sign-in form, so step 1 is a step
    // rather than a form at the bottom of the panel.
    return { refresh: show, done, account: q('.gs-account'),
        blocks: () => registerBlocks(q, say),
        connect: () => connect(q, say).then((c) => { layers.found = c; }) };
}
