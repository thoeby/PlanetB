// flowsui.js — the Automate view (SPEC §2.16), whole.
//
// Three columns and a bar: the flows on the left, the canvas in the middle, the
// inspector on the right, and Save / Validate / Export / Import / Close over
// them. The view takes the window because a flow is not a form beside the
// world; while it is open the 3D view is paused, and the moment it closes the
// world is drawn again.
//
// Saving is flows.js's four steps, in order. What is dirty is what this tab has
// done since the last save; a flow saved from another tab is refused by the
// database (db/0133) rather than quietly overwritten, and the sentence it comes
// back with is the one shown.

import { el } from './poolui.js';
import * as flows from './flows.js';
import { bootFlow } from '../flow/boot.js';
import { mountCanvas, EMPTY_FLOW } from './flowcanvas.js';
import { mountFlowList, ask } from './flowlist.js';
import { mountInspector } from './flowinspector.js';
import { parseElx } from '../flow/elx/parse.js';
import { topBar } from './flowsbar.js';
import { bindKeys, refresh, create, openFlow, save } from './flowsdo.js';

// The columns, once. Everything below fills them.
function frame(doc) {
    const root = el('div', { id: 'flows' });
    root.hidden = true;
    const left = el('div', { className: 'fl-left' });
    const mid = el('div', { className: 'fl-mid' });
    const right = el('div', { className: 'fl-right' });
    const bar = topBar();
    root.append(bar.node, left, mid, right);
    // Inside the chrome, not beside it: the apps drawer and the top strip hang
    // off #hud and have to stay over the view, or the key that opened Automate
    // cannot be used to leave it.
    (doc.getElementById('hud') ?? doc.body).append(root);
    return { root, left, mid, right, bar };
}

// litegraph, the canvas, the inspector and the keys — the first time somebody
// opens the view, and never at page load.
async function boot(ctx) {
    if (ctx.canvas) return ctx.canvas;
    const lg = await bootFlow(flows.bundledPlugins());
    ctx.canvas = mountCanvas(ctx.mid, lg, {
        changed: () => { ctx.mark(true); ctx.inspector?.show(ctx.canvas.selected()); },
        selected: (node) => ctx.inspector?.show(node),
        scope: () => ctx.inspector?.show(null),
        trouble: (text) => ctx.say(text),
    });
    ctx.inspector = mountInspector(ctx.right, ctx.canvas, { changed: () => ctx.mark(true) });
    ctx.bar.wire(ctx.canvas, ctx.acts);
    bindKeys(ctx.root, ctx.canvas, ctx.acts.save);
    return ctx.canvas;
}

// Closing with something unsaved asks the three-way question the story asks
// for: Save, Discard, or stay where you are.
function closing(ctx) {
    if (ctx.root.hidden) return;
    if (!ctx.state.dirty) { ctx.hide(); return; }
    const box = ask(ctx.root, {
        title: `${ctx.state.open?.name ?? 'This flow'} has unsaved changes.`,
        value: ctx.state.open?.name ?? '', ok: 'Save',
        onOk: async () => { await ctx.acts.save(); ctx.hide(); },
        onCancel: () => ctx.stay(),
    });
    const discard = el('button', { type: 'button', className: 'fl-discard',
        textContent: 'Discard' });
    discard.onclick = () => { ctx.mark(false); box.close(); ctx.hide(); };
    box.node.querySelector('.fl-acts').prepend(discard);
}

export function mountFlows(doc, { onOpen, onClose, onStay, lands }) {
    const { root, left, mid, right, bar } = frame(doc);
    const ctx = {
        root, mid, right, bar, lands, canvas: null, inspector: null,
        state: { open: null, dirty: false, said: '' },
        parse: parseElx, empty: EMPTY_FLOW,
        say: (text) => { ctx.state.said = text; bar.said.textContent = text; },
        mark(dirty) {
            ctx.state.dirty = dirty;
            bar.dirty.hidden = !dirty;
            bar.save.disabled = !ctx.state.open;
            bar.undo.disabled = !ctx.canvas?.canUndo();
            bar.redo.disabled = !ctx.canvas?.canRedo();
        },
        boot: () => boot(ctx),
        hide: () => { root.hidden = true; onClose?.(); },
        // Answering "Stay" to the closing question puts the view back: the
        // chrome may already have been dressed for another one.
        stay: () => { root.hidden = false; onStay?.(); },
    };
    // Validate, export and import are FND.2's; the buttons are here because the
    // bar is, and they say so rather than doing nothing.
    const later = (what) => () => ctx.say(`${what} comes with the next story.`);
    ctx.acts = {
        save: () => save(ctx), close: () => closing(ctx),
        validate: later('Validate'), exportElx: later('Export'), importElx: later('Import'),
    };
    ctx.list = mountFlowList(left, {
        create: (areaId, name) => create(ctx, areaId, name),
        open: (row) => openFlow(ctx, row),
        rename: (row, name) => flows.renameFlow(row, name).then(() => refresh(ctx)),
        duplicate: (row, name) => flows.duplicateFlow(row, name).then(() => refresh(ctx)),
        remove: (row) => flows.deleteFlow(row.id, row.rev).then(() => {
            if (ctx.state.open?.id === row.id) ctx.state.open = null;
            return refresh(ctx);
        }),
    });

    return {
        node: root,
        async show() {
            root.hidden = false;
            onOpen?.();
            try {
                await boot(ctx);
                ctx.canvas.fit();
                await refresh(ctx);
                ctx.mark(ctx.state.dirty);
            } catch (err) {
                ctx.say(String(err?.message ?? err));
            }
        },
        hide: ctx.hide,
        close: () => closing(ctx),
        isOpen: () => !root.hidden,
        said: () => ctx.state.said,
        dirty: () => ctx.state.dirty,
        openFlow: (row) => openFlow(ctx, row),
        save: () => save(ctx),
        refresh: () => refresh(ctx),
        canvas: () => ctx.canvas,
    };
}
