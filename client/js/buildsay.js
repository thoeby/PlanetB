// buildsay.js — what the Place panel says about where you are and what is
// selected, and the two reads behind it.
//
// Split out of buildui.js for size (CLAUDE.md), not because it is a layer:
// there is nothing here but the sentences the panel puts on the screen and the
// list of tiles under them.

import * as api from './api.js';
import { stepWords } from './build.js';
import { tileRow } from './buildrows.js';

export function describe(state, depth) {
    if (state.proposal && !state.selected) {
        return `proposed ${String(state.proposal).slice(0, 8)} — an approver has to merge it`;
    }
    if (!state.selected) {
        return `${state.brush ? `brush ${state.brush.san}` : 'nothing selected'}`
            + ` · ${depth} undoable`;
    }
    return `${state.selected.san} · ${state.mode} ${state.axis}`
        + ` · scale ${Number(state.selected.scale ?? 1).toFixed(2)} · ${depth} undoable`;
}

// SPEC §3.4: "you may not build here (owner Anna)" — the sentence names the
// land and the person, because "5842edf5" is not an answer to "why not".
export const whereText = (state, areas) => {
    if (!state.area) {
        const theirs = areas[0];
        return theirs
            ? `you may not build here — ${theirs.name} belongs to ${theirs.owner}.`
              + ' Ask them for a build grant'
            : 'you may not build here — nobody owns this ground. Ask an admin'
              + ' for land';
    }
    const how = state.area.may_write ? 'building on' : 'proposing to';
    return `${how} ${state.area.name} · detail ${state.area.detail}`;
};

// Build mode takes the keyboard and the pointer off the player: the camera
// stands still and the cursor is free, which is what makes a click a placement
// rather than a request for pointer lock.
export function showChosen(host, state) {
    for (const b of host.querySelectorAll('[data-mode]')) {
        b.dataset.on = b.dataset.mode === state.mode ? '1' : '';
    }
    for (const b of host.querySelectorAll('[data-axis]')) {
        b.dataset.on = b.dataset.axis === state.axis ? '1' : '';
    }
    const step = host.querySelector('.build-step');
    if (step) step.textContent = stepWords(state);
}

// SPEC §3.4 step 4: "2 objects saved · 1 tile changed". The numbers are the
// world's own — what was written, and what the tiles say afterwards.
export async function saveAndSay(session, refresh, line) {
    const done = await session.save();
    const tiles = await refresh();
    const changed = (tiles ?? []).filter((t) => t.dirty).length;
    line.textContent = done.objects
        ? `${done.objects} object${done.objects === 1 ? '' : 's'} saved`
          + ` \u00b7 ${changed} tile${changed === 1 ? '' : 's'} changed`
        : 'nothing to save — place something first';
    return done;
}

// Opening a tile's job from its row, and telling the wallet which one it is:
// WP4.4, a bounty attaches to a job.
export function opener(ctx) {
    return async (tile, btn) => {
        btn.disabled = true;
        const job = await api.rpc('ensure_job', { z: tile.z, x: tile.x, y: tile.y });
        btn.textContent = `job ${job}`;
        ctx.work?.refresh?.();
        ctx.wallet?.target?.(tile, job);
    };
}

// Where you are and what you may do here is worth saying whether or not build
// mode is on: a player opens this panel to find out.
export function looker(host, ctx, session, say, movers = null) {
    const render = opener(ctx);
    return async () => {
        say();
        const { areas, tiles } = await session.look();
        // FND.16: the buses are the land's, so the list follows whose ground
        // the player is standing on — whether or not they may build on it. A
        // bus is a thing everybody can see, and the timetable is public.
        await movers?.refresh(session.state.area?.id ?? areas[0]?.id ?? null);
        host.querySelector('.build-where').textContent
            = whereText(session.state, areas);
        host.querySelector('.build-tiles')
            .replaceChildren(...tiles.map((t) => tileRow(t, render)));
        const open = tiles.find((t) => t.job_id) ?? tiles.find((t) => t.dirty);
        if (open) ctx.wallet?.target?.(open, open.job_id ?? null);
        return tiles;
    };
}

