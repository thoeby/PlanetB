// flowsdo.js — what the Automate view does, away from what it looks like.
//
// Each of these takes the view's context: its state, its bar, its list and its
// canvas. Split out of flowsui.js for size (CLAUDE.md), not because it is a
// layer; there is nothing here but the things a player does to a flow — open
// it, save it, import one, export one, and ask whether it would run.

import * as flows from './flows.js';
import { importElx, download } from './flowfiles.js';
import { localProblems, askServer, checkingServer } from './flowcheck.js';
import { addWorldInputs } from './flowworld.js';

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

export async function refresh(ctx) {
    const rows = await flows.listFlows();
    ctx.list.set(rows, await ctx.lands(), ctx.state.open?.id ?? null);
    return rows;
}

// A new flow is an empty one, saved at once: the ELX of an empty flow is still
// an ELX, and a flow that exists nowhere until it is drawn cannot be listed.
export async function create(ctx, areaId, name) {
    const canvas = await ctx.boot();
    canvas.open(ctx.empty(), {});
    // FND.14: `world` and `world_key` come with every flow, because a World
    // block put in later has nothing to reach the world with otherwise.
    addWorldInputs(canvas);
    const res = await flows.saveFlow({ areaId, name, elx: canvas.elx(), layout: {} });
    ctx.state.open = { id: res.id, area_id: areaId, name, rev: res.rev,
        elx_sha256: res.elx_sha256 };
    ctx.bar.name.textContent = name;
    ctx.mark(false);
    ctx.say('saved');
    await refresh(ctx);
}

export async function openFlow(ctx, row) {
    const canvas = await ctx.boot();
    const elx = await flows.elxOf(row.elx_sha256);
    canvas.open(ctx.parse(elx), row.layout ?? {});
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
    const url = await checkingServer();
    const answer = await askServer(url, text, location.origin);
    const mine = local.length
        ? `${local.length} problem(s) here`
        : 'nothing wrong here';
    ctx.say(answer.asked ? `${answer.words} · ${mine}` : `${mine} · ${answer.words}`);
    return { local, answer };
}
