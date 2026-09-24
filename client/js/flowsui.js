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
// database (db/0155) rather than quietly overwritten, and the sentence it comes
// back with is the one shown.

import { el } from './poolui.js';
import * as api from './api.js';
import * as flows from './flows.js';
import { bootFlow } from '../flow/boot.js';
import { mountCanvas, EMPTY_FLOW } from './flowcanvas.js';
import { mountFlowList, ask } from './flowlist.js';
import { mountInspector } from './flowinspector.js';
import { parseElx } from '../flow/elx/parse.js';
import { topBar } from './flowsbar.js';
import { mountServerPicker } from './serverpicker.js';
import { flowBlocks } from './flowblocks.js';
import { isWorldBlock, setConstant } from './flowworld.js';
import { leftTabs } from './servertab.js';
import { mountProcesses } from './serverprocs.js';
import { mountServices } from './serverservices.js';
import { mountJobs } from './serverjobs.js';
import { mountReports, mountRunPanel } from './serverreports.js';
import { mountPlanner } from './plannerui.js';
import { openRemote, intoLand, sendFlow } from './serverdo.js';
import { bindKeys, refresh, create, openFlow, save, importFiles, exportFlow, validate }
    from './flowsdo.js';

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
// opens the view, and never at page load. The promise is kept, not just the
// result: two callers that arrive while the plugins are still being fetched
// would otherwise each build a canvas, and the view would have two of
// everything.
function boot(ctx) {
    ctx.booting = ctx.booting ?? building(ctx);
    return ctx.booting;
}

async function building(ctx) {
    const bundled = await flows.bundledPlugins();
    const lg = await bootFlow(bundled);
    ctx.blocks = flowBlocks({ LiteGraph: lg.LiteGraph, bundled, say: ctx.say });
    ctx.canvas = mountCanvas(ctx.mid, lg, {
        changed: () => {
            ctx.mark(true);
            ctx.blocks.mark(ctx.canvas?.graph);
            ctx.inspector?.show(ctx.canvas.selected());
        },
        refreshBlocks: () => ctx.blocks.again().then(() => repaint(ctx)),
        // FL.6: a World block dropped into a flow that belongs to a thing
        // starts out pointed at that thing; the World section still changes it.
        placed: (node) => {
            const thing = ctx.state.open?.instance_id;
            const aims = (node.inputs ?? []).some((i) => i.name === 'Object');
            if (thing && isWorldBlock(node) && aims) {
                setConstant(node, 'Object', thing);
            }
        },
        selected: (node) => ctx.inspector?.show(node),
        scope: () => ctx.inspector?.show(null),
        trouble: (text) => ctx.say(text),
        files: (files) => importFiles(ctx, files),
    });
    ctx.inspector = mountInspector(ctx.right, ctx.canvas,
        { changed: () => ctx.mark(true), world: ctx.world });
    ctx.bar.wire(ctx.canvas, ctx.acts);
    bindKeys(ctx.root, ctx.canvas, ctx.acts.save);
    ctx.server.onChange((server) => ctx.blocks.use(server).then(() => repaint(ctx)));
    return ctx.canvas;
}

// FL.2: the palette and the hatching follow the chosen server's blocks.
function repaint(ctx) {
    ctx.canvas.palette.refresh({ visible: ctx.blocks.visible, from: ctx.blocks.from,
        server: ctx.blocks.server()?.name });
    ctx.blocks.mark(ctx.canvas.graph);
    ctx.inspector?.show(ctx.canvas.selected());
}

// The server picker is started once the canvas is there, so the first server
// it settles on reaches the palette.
async function serverFirst(ctx) {
    await ctx.server.start();
    const now = ctx.server.current();
    if (ctx.blocks.server()?.id !== now?.id || ctx.blocks.server()?.url !== now?.url) {
        await ctx.blocks.use(now);
        repaint(ctx);
    }
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

// An .elx from the machine: the Import button opens this, and a file dropped
// on the canvas goes the same way (flowcanvas.js hands it over).
function filePicker(ctx) {
    const picker = el('input', { type: 'file', accept: '.elx,application/xml',
        multiple: true, className: 'fl-file' });
    picker.hidden = true;
    picker.onchange = async () => {
        const files = [...picker.files];
        picker.value = '';
        await importFiles(ctx, files);
    };
    return picker;
}

// What the World blocks in a flow are offered: the objects on the flow's own
// land, asked for once per land, and the 3D view's own picker (FND.14).
function worldBag(ctx, pickObject) {
    let cache = { area: null, rows: null };
    return {
        objects() {
            const area = ctx.state.open?.area_id ?? null;
            if (!area) return Promise.resolve([]);
            if (cache.area !== area) cache = { area, rows: flows.objectsOn(area) };
            return cache.rows;
        },
        // Automate steps aside while the world is asked, and comes back with
        // whatever was clicked — or with nothing, if the player thought better.
        async pick() {
            const area = ctx.state.open?.area_id ?? null;
            if (!area || !pickObject) return null;
            const land = (await ctx.lands()).find((l) => l.id === area);
            ctx.root.hidden = true;
            try {
                const row = await pickObject(land?.name ?? 'this land');
                return row?.id ? { id: row.id } : null;
            } finally { ctx.root.hidden = false; }
        },
    };
}

// FL.3–FL.5: what is on the chosen server, in the left column's second tab.
// Every list is asked for again when the server changes.
function remoteLists(ctx, tabs) {
    const bag = {
        server: () => ctx.server.current(),
        say: ctx.say,
        dialogs: () => ctx.root,
        open: (server, row) => openRemote(ctx, server, row),
        intoLand: (server, row) => intoLand(ctx, server, row),
        visible: (plugin) => ctx.blocks?.served(plugin) ?? true,
        runPanel: mountRunPanel(ctx.mid),
        reload: () => run(),
    };
    const parts = [mountProcesses, mountServices, mountJobs, mountReports]
        .map((mount) => mount(tabs.remotePane, bag));
    bag.planner = mountPlanner(ctx.root, bag);
    const run = () => (bag.server() ? Promise.all(parts.map((p) => p.run())) : null);
    ctx.server.onChange((s) => {
        tabs.server(s);
        ctx.bar.send.textContent = s ? `Send to ${s.name}` : 'Send';
        ctx.bar.send.disabled = !s;
        run();
        if (s && bag.planner && !bag.planner.node.hidden) bag.planner.open();
    });
    return { run, parts, bag, tabs };
}

// Everything the view holds, in one bag the actions in flowsdo.js are handed.
function context(parts, { onClose, onStay, lands, pickObject }) {
    const { root, mid, right, bar } = parts;
    const ctx = {
        root, mid, right, bar, lands, canvas: null, inspector: null,
        state: { open: null, dirty: false, said: '', problems: [] },
        parse: parseElx, empty: EMPTY_FLOW,
        say: (text) => { ctx.state.said = text; bar.said.textContent = text; },
        // What Validate found, in the panel under the inspector: each problem
        // says where it is, and pressing it goes to the block it is about.
        problems(list) {
            ctx.state.problems = list;
            ctx.inspector?.problems(list, (block) => ctx.canvas?.goTo(block));
        },
        mark(dirty) {
            ctx.state.dirty = dirty;
            bar.dirty.hidden = !dirty;
            bar.save.disabled = !ctx.state.open;
            const remote = ctx.state.remote;
            bar.save.hidden = Boolean(remote);
            bar.keep.hidden = !remote;
            bar.ro.hidden = !remote;
            bar.undo.disabled = !ctx.canvas?.canUndo();
            bar.redo.disabled = !ctx.canvas?.canRedo();
        },
        boot: () => boot(ctx),
        hide: () => { root.hidden = true; ctx.server.stop(); onClose?.(); },
        // Answering "Stay" to the closing question puts the view back: the
        // chrome may already have been dressed for another one.
        stay: () => { root.hidden = false; onStay?.(); },
    };
    ctx.world = worldBag(ctx, pickObject);
    ctx.server = mountServerPicker(bar.server, () => root, {
        // Design 10f: a server that runs flows of yours is not removed.
        async removable(s) {
            const runs = await api.select('flow_deployment', { select: 'id',
                server_id: `eq.${s.id}`, revoked_at: 'is.null' }).catch(() => []);
            return runs.length
                ? `${s.name} runs ${runs.length} of your flows \u2014 stop them first.` : '';
        },
    });
    return ctx;
}

export function mountFlows(doc, opts) {
    const parts = frame(doc);
    const { root, left } = parts;
    const ctx = context(parts, opts);
    const picker = filePicker(ctx);
    root.append(picker);
    ctx.acts = {
        save: () => save(ctx), close: () => closing(ctx),
        validate: () => validate(ctx),
        exportElx: () => exportFlow(ctx),
        importElx: () => picker.click(),
        send: () => sendFlow(ctx),
        keep: () => ctx.state.remote
            && intoLand(ctx, ctx.state.remote.server, ctx.state.remote.row),
    };
    const tabs = leftTabs(left);
    ctx.remoteLists = remoteLists(ctx, tabs);
    ctx.list = mountFlowList(tabs.minePane, {
        create: (areaId, name, instance) => create(ctx, areaId, name, instance),
        objectsOn: (areaId) => flows.objectsOn(areaId),
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
            opts.onOpen?.();
            try {
                await boot(ctx);
                serverFirst(ctx).catch((err) => ctx.say(String(err?.message ?? err)));
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
        // FL.6: a new flow for a thing, made from the thing's own panel.
        createFor: (areaId, name, instance) => create(ctx, areaId, name, instance),
        save: () => save(ctx),
        validate: () => validate(ctx),
        exportFlow: () => exportFlow(ctx),
        importFiles: (files, areaId) => importFiles(ctx, files, areaId),
        problems: () => ctx.state.problems,
        refresh: () => refresh(ctx),
        canvas: () => ctx.canvas,
    };
}
