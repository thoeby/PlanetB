// flowsdo.js — what the Automate view does, away from what it looks like.
//
// Each of these takes the view's context: its state, its bar, its list and its
// canvas. Split out of flowsui.js for size (CLAUDE.md), not because it is a
// layer; there is nothing here but the things a player does to a flow — open
// it, save it, import one, export one, and ask whether it would run.

import * as api from './api.js';
import * as flows from './flows.js';
import { servers } from './processservers.js';
import { importElx, download } from './flowfiles.js';
import { localProblems, askServer, checkingServer } from './flowcheck.js';
import { addWorldInputs, setConstant } from './flowworld.js';

// Keys belong to the view while it is open: Ctrl-Z and Ctrl-Shift-Z are undo
// and redo, Delete takes the selection away, and nothing fires while somebody
// is typing a name.
export function bindKeys(root, canvas, save) {
    root.addEventListener('keydown', (e) => {
        if (e.target?.closest?.('input, select, textarea')) return;
        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) canvas.redo(); else canvas.undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && key === 's') {
            e.preventDefault();
            save();
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (canvas.removeSelected()) e.preventDefault();
        }
    });
}

// FL.7, design 10a: which server each flow runs on, and whether it changed
// since it was sent there.
async function sentTo(rows) {
    const runs = await api.select('flow_deployment', { select: 'flow_id,server_id,elx_sha256',
        revoked_at: 'is.null' }).catch(() => []);
    if (!runs.length) return new Map();
    const names = new Map((await servers()).map((s) => [s.id, s.name]));
    const out = new Map();
    for (const r of runs) {
        const flow = rows.find((f) => f.id === r.flow_id);
        if (!flow) continue;
        out.set(r.flow_id, { server: names.get(r.server_id) ?? 'a server',
            changed: r.elx_sha256 !== flow.elx_sha256 });
    }
    return out;
}

export async function refresh(ctx) {
    const rows = await flows.listFlows();
    const things = await flows.thingNames(
        [...new Set(rows.map((r) => r.instance_id).filter(Boolean))]);
    const [lands, runs] = await Promise.all([ctx.lands(), sentTo(rows)]);
    ctx.list.set(rows, lands, ctx.state.open?.id ?? null, things, runs);
    ctx.home?.set(rows, lands, ctx.state.open?.id ?? null, things, runs);
    // Design 10a: beside the flow's name, the land and the thing it is on.
    const open = ctx.state.open;
    if (open) {
        const land = lands.find((a) => a.id === open.area_id)?.name;
        const thing = open.instance_id && things.get(open.instance_id)?.name;
        ctx.bar.where.textContent = [land, thing].filter(Boolean).join(' \u00b7 ');
    } else if (!ctx.state.remote) ctx.bar.where.textContent = '';
    return rows;
}

// FL.6: a flow made for a thing starts with what reaches it — World Clock, and
// Write Port pointed at the thing and at its first switch — both wired to the
// flow's `world` and `world_key`.
async function seedForThing(canvas, areaId, instance) {
    const thing = (await flows.objectsOn(areaId)).find((o) => o.id === instance);
    const clock = canvas.add('world', 'clock.now', [300, 40]);
    const write = canvas.add('world', 'port.write', [300, 200]);
    for (const node of [clock, write]) {
        canvas.wireInput('world', node, 'World');
        canvas.wireInput('world_key', node, 'World Key');
    }
    setConstant(write, 'Object', instance);
    const port = thing?.ports.find((p) => p.type === 'boolean') ?? thing?.ports[0];
    if (port) setConstant(write, 'Port', port.name);
}

// A new flow is an empty one, saved at once: the ELX of an empty flow is still
// an ELX, and a flow that exists nowhere until it is drawn cannot be listed.
// A world flow is the player's to change; a process looked at on a server
// (serverdo.js openRemote, FL.3) was not.
function writable(ctx, canvas) {
    canvas.view.read_only = false;
    ctx.state.remote = null;
}

export async function create(ctx, areaId, name, instance = null) {
    const canvas = await ctx.boot();
    writable(ctx, canvas);
    canvas.open(ctx.empty(), {});
    // FND.14: `world` and `world_key` come with every flow, because a World
    // block put in later has nothing to reach the world with otherwise.
    addWorldInputs(canvas);
    if (instance) await seedForThing(canvas, areaId, instance);
    const res = await flows.saveFlow({ areaId, name, elx: canvas.elx(),
        layout: instance ? canvas.layout() : {}, instance });
    ctx.state.open = { id: res.id, area_id: areaId, name, rev: res.rev,
        elx_sha256: res.elx_sha256, instance_id: instance };
    ctx.pages?.go('Editor');
    ctx.bar.name.textContent = name;
    ctx.mark(false);
    ctx.say('saved');
    await refresh(ctx);
}

export async function openFlow(ctx, row) {
    const canvas = await ctx.boot();
    const elx = await flows.elxOf(row.elx_sha256);
    writable(ctx, canvas);
    canvas.open(ctx.parse(elx), row.layout ?? {});
    ctx.pages?.go('Editor');
    ctx.state.open = { ...row };
    ctx.bar.name.textContent = row.name;
    ctx.mark(false);
    ctx.say('');
    await refresh(ctx);
}

// The save path, in order: ELX out of the graph, hashed, PUT, registered, and
// only then the land's pointer moved (flows.js). A stale rev comes back as the
// sentence db/0155 raises, which is the one worth showing.
export async function save(ctx) {
    if (!ctx.state.open) return;
    try {
        const res = await flows.saveFlow({
            id: ctx.state.open.id, areaId: ctx.state.open.area_id,
            name: ctx.state.open.name, elx: ctx.canvas.elx(),
            layout: ctx.canvas.layout(), rev: ctx.state.open.rev,
        });
        ctx.state.open.rev = res.rev;
        ctx.state.open.elx_sha256 = res.elx_sha256;
        ctx.mark(false);
        ctx.say('saved');
        await refresh(ctx);
    } catch (err) {
        ctx.say(String(err?.message ?? err).replace(/^\d+ \S+: /, ''));
    }
}

// ------------------------------------------------------------ files, checks

// Import: one or more .elx, each becoming a flow of its own on the land the
// player is working on. A file the format does not recognise is named in the
// sentence and the rest still arrive.
export async function importFiles(ctx, files, areaId) {
    await ctx.boot();
    const land = areaId ?? ctx.state.open?.area_id ?? (await ctx.lands())[0]?.id;
    if (!land) { ctx.say('You build on no land yet, so there is nowhere to put a flow.'); return; }
    const taken = ctx.list.rows().filter((r) => r.area_id === land).map((r) => r.name);
    const done = [];
    for (const file of files) {
        try {
            const row = await importElx(file, land, [...taken, ...done]);
            done.push(row.name);
        } catch (err) {
            ctx.say(String(err?.message ?? err).replace(/^\d+ \S+: /, ''));
            break;
        }
    }
    if (!done.length) return;
    await refresh(ctx);
    const row = ctx.list.rows().find((r) => r.name === done.at(-1));
    if (row) await openFlow(ctx, row);
    // Nothing in an ELX says where a block sits, so an imported flow is laid
    // out — and only the layout is saved. The file keeps its own bytes: an
    // export has to give back what came in, and this editor's serializer
    // writes the same flow in its own order (nodes before nets), which would
    // be it quietly rewriting somebody else's file.
    ctx.canvas.relayout();
    await saveLayout(ctx);
    ctx.say(`imported ${done.join(', ')}`);
}

// The layout, saved beside a flow whose ELX has not changed. Same compare-and-
// swap, same row; the pointer is moved to the file it already points at.
export async function saveLayout(ctx) {
    if (!ctx.state.open) return;
    const res = await flows.saveFlow({
        id: ctx.state.open.id, areaId: ctx.state.open.area_id,
        name: ctx.state.open.name, sha: ctx.state.open.elx_sha256,
        layout: ctx.canvas.layout(), rev: ctx.state.open.rev,
    });
    ctx.state.open.rev = res.rev;
    ctx.mark(false);
    await refresh(ctx);
}

// Export: the bytes that were saved, not a fresh serialization of the canvas.
// They are the same only when nothing is unsaved, which is why a dirty flow is
// asked to be saved first rather than quietly exported as something else.
export async function exportFlow(ctx) {
    if (!ctx.state.open) return;
    if (ctx.state.dirty) { ctx.say('save first'); return; }
    const elx = await flows.elxOf(ctx.state.open.elx_sha256);
    download(ctx.state.open.name, elx);
    ctx.say(`exported ${ctx.state.open.name}.elx`);
}

// Validate: the process server's answer and this page's own, both of them,
// always, and both about the same bytes — the ones that would be run. For a
// flow with unsaved changes those are the canvas's; for a saved one they are
// the file's, which for an imported flow is the file exactly as it arrived.
//
// That distinction is the whole use of the local check. A canvas cannot hold a
// wire the ports refuse — litegraph vetoes it as it is made, and import drops
// it — so checking the canvas would only ever find nothing. The file is where
// the problems are.
export async function validate(ctx) {
    if (!ctx.canvas) return;
    const text = ctx.state.dirty || !ctx.state.open?.elx_sha256
        ? ctx.canvas.elx()
        : await flows.elxOf(ctx.state.open.elx_sha256);
    const flow = ctx.state.dirty ? ctx.canvas.flow() : ctx.parse(text);
    const local = localProblems(flow);
    ctx.problems(local);
    // FL.3: the chosen process server is asked; with none chosen, the world's.
    const url = ctx.server?.current()?.url ?? await checkingServer();
    const answer = await askServer(url, text, location.origin);
    const mine = local.length
        ? `${local.length} problem(s) here`
        : 'nothing wrong here';
    ctx.say(answer.asked ? `${answer.words} · ${mine}` : `${mine} · ${answer.words}`);
    return { local, answer };
}
