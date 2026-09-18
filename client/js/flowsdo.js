// flowsdo.js — what the Automate view does, away from what it looks like.
//
// Each of these takes the view's context: its state, its bar, its list and its
// canvas. Split out of flowsui.js for size (CLAUDE.md), not because it is a
// layer; there is nothing here but the four things a player does to a flow.

import * as flows from './flows.js';

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
    const res = await flows.saveFlow({ areaId, name, elx: canvas.elx(), layout: {} });
    ctx.state.open = { id: res.id, area_id: areaId, name, rev: res.rev };
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
// sentence db/0133 raises, which is the one worth showing.
export async function save(ctx) {
    if (!ctx.state.open) return;
    try {
        const res = await flows.saveFlow({
            id: ctx.state.open.id, areaId: ctx.state.open.area_id,
            name: ctx.state.open.name, elx: ctx.canvas.elx(),
            layout: ctx.canvas.layout(), rev: ctx.state.open.rev,
        });
        ctx.state.open.rev = res.rev;
        ctx.mark(false);
        ctx.say('saved');
        await refresh(ctx);
    } catch (err) {
        ctx.say(String(err?.message ?? err).replace(/^\d+ \S+: /, ''));
    }
}
