// flowcanvas.js — the middle of the Automate view: litegraph, and what the
// player does to it.
//
// The graph itself is the reference editor's (client/flow/): importFlow builds
// litegraph nodes from an ELX flow, exportFlow reads them back. What is here is
// only the surface — the canvas element, the palette drop, the delete key, undo
// and redo, auto-layout, and the breadcrumb into a subflow.

import { el } from './poolui.js';
import { dress } from '../flow/boot.js';
import { importFlow } from '../flow/graph/import.js';
import { exportFlow } from '../flow/graph/export.js';
import { serializeElx } from '../flow/elx/serialize.js';
import { parseElx } from '../flow/elx/parse.js';
import { layout as autoLayout } from '../flow/graph/layout.js';
import { createHistory, attachHistory, markGraphDirty } from '../flow/graph/history.js';
import { getBlock } from '../flow/plugins/registry.js';
import { typeName } from '../flow/graph/register.js';
import { attachSubgraphChrome } from '../flow/graph/subflow.js';
import { userNamedNets, getNetMode, setNetMode, applyHiddenFlags }
    from '../flow/graph/namednets.js';
import { setLayout, getLayout, flowHash, watchDragsForLayout }
    from '../flow/graph/layoutstore.js';
import { mountPalette } from './flowpalette.js';

export const EMPTY_FLOW = () => ({
    engine: { type: 'flow', maxSteps: 10000, recordHistory: false },
    inputs: [], outputs: [], nodes: [], subflows: [], nets: [],
});

// A name no block in this scope has yet: "contains", "contains 2", …
export function freeName(graph, wanted) {
    const taken = new Set((graph._nodes ?? []).map((n) => n._irName));
    if (!taken.has(wanted)) return wanted;
    for (let i = 2; ; i++) if (!taken.has(`${wanted} ${i}`)) return `${wanted} ${i}`;
}

// A block from the palette, stamped with what the exporter reads off it. The
// reference editor spawns the litegraph node and stops there, which is enough
// to draw with and not enough to save: exportFlow takes a node's ELX id, its
// plugin and its parameter list from these, and a node without them comes out
// as `<node id="" plugin="">`.
function newNode(graph, block, LiteGraph, at) {
    const type = typeName(block);
    const node = LiteGraph.createNode(type);
    if (!node) throw new Error(`the palette has no ${type}`);
    node._irName = freeName(graph, block.name || block.id);
    node.title = node._irName;
    node._irKind = 'node';
    node._irPlugin = block.plugin;
    node._irNodeId = [...block.groupPath, block.id].join('.');
    // The parameters as the plugin declares them, at their defaults. The
    // inspector writes through `node.properties`, which exportFlow reads back
    // over this list.
    node._irParameters = (block.parameters ?? []).map((p) => ({
        id: p.id,
        value: { id: p.default?.id ?? 'string', data: p.default?.data ?? '' },
    }));
    node._irConstants = [];
    node.pos = [at?.[0] ?? 80, at?.[1] ?? 80];
    graph.add(node);
    return node;
}

// The canvas element, sized to whatever it is given. litegraph does not watch
// its own container, so this does.
function makeCanvas(host, benchHost) {
    // The palette is a column of its own beside the canvas (design 10a) rather
    // than a panel floating on it: a list that covers the drawing is a list you
    // cannot drag past, and the first wire drawn under one started by picking
    // up a palette line.
    const bench = benchHost ?? el('div', { className: 'fl-bench' });
    const wrap = el('div', { className: 'fl-canvas-wrap' });
    const canvasEl = el('canvas', { className: 'fl-canvas' });
    wrap.append(canvasEl);
    host.append(...(benchHost ? [] : [bench]), wrap);
    return { bench, wrap, canvasEl };
}

// A snapshot is the ELX of the moment: the same bytes the save writes, so undo
// can never restore something that could not have been saved.
function makeHistory(graph, restore, changed) {
    const history = createHistory({
        serialize: (g) => { try { return serializeElx(exportFlow(g)); } catch { return null; } },
        restore: (_g, snap) => restore(parseElx(snap)),
        onChange: changed,
    });
    attachHistory(graph, history);
    return history;
}

// A drop on the canvas is one of two things: a line from the palette, which
// becomes a block where the pointer was let go, or an .elx from the machine,
// which becomes a flow of its own (FND.2). Anything else is ignored.
function wireDrop(wrap, palette, put, onFiles) {
    wrap.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    wrap.ondrop = (e) => {
        e.preventDefault();
        const files = [...(e.dataTransfer.files ?? [])]
            .filter((f) => /\.elx$/i.test(f.name) || f.type.includes('xml'));
        if (files.length) { onFiles?.(files); return; }
        const block = palette.blockOf(e.dataTransfer.getData('text/plain'));
        if (block) put(block, { clientX: e.clientX, clientY: e.clientY });
    };
}

// Where a screen point is on the graph.
function graphPoint(view, canvasEl, point) {
    if (!point) return null;
    if (view.convertEventToCanvasOffset) return view.convertEventToCanvasOffset(point);
    const r = canvasEl.getBoundingClientRect();
    return [point.clientX - r.left, point.clientY - r.top];
}

// FL.6: a block by its plugin and ELX id, where a flow made for a thing starts
// with it, and a wire from a flow input to one of its inputs.
function seeding({ graph, LiteGraph }) {
    return {
        add(plugin, elxId, at) {
            const node = newNode(graph, getBlock(plugin, elxId), LiteGraph, at);
            markGraphDirty(graph);
            return node;
        },
        wireInput(from, node, port) {
            const src = (graph._nodes ?? []).find((n) => n._irName === from);
            const slot = (node.inputs ?? []).findIndex((i) => i.name === port);
            if (src && slot >= 0) src.connect(0, node, slot);
        },
    };
}

// What the workspace holds on to: the graph, and everything it asks of it.
function handle(parts, on) {
    const { graph, view, palette, history, load, select, fit } = parts;
    return {
        ...parts,
        open(flow, layout) { load(flow, { layout }); palette.refresh(); },
        flow: () => exportFlow(graph),
        elx: () => serializeElx(exportFlow(graph)),
        layout: () => getLayout(),
        // Every net somebody named, and whether it is drawn as wire or label.
        nets: () => userNamedNets(graph)
            .map((name) => ({ name, mode: getNetMode(graph, name) })),
        toggleNet(name) {
            setNetMode(graph, name, getNetMode(graph, name) === 'wires' ? 'labels' : 'wires');
            graph.setDirtyCanvas(true, true);
            on.changed?.();
        },
        selected: () => (view.selected_nodes
            ? Object.values(view.selected_nodes)[0] ?? null : null),
        // Put a named block in the middle of the view and select it: what a
        // problem in the check list does when it is pressed.
        goTo(name) {
            const node = (graph._nodes ?? []).find((n) => n._irName === name);
            if (!node) return false;
            const r = view.canvas.getBoundingClientRect();
            view.ds.offset[0] = r.width / (2 * view.ds.scale) - node.pos[0];
            view.ds.offset[1] = r.height / (2 * view.ds.scale) - node.pos[1];
            parts.select(node);
            graph.setDirtyCanvas(true, true);
            return true;
        },
        removeSelected() {
            const sel = Object.values(view.selected_nodes ?? {});
            if (!sel.length) return 0;
            for (const n of sel) graph.remove(n);
            markGraphDirty(graph);
            on.selected?.(null);
            return sel.length;
        },
        ...seeding(parts),
        // The same placement importFlow uses when a flow has no layout at all.
        relayout() {
            const pos = autoLayout(exportFlow(graph), getBlock);
            for (const n of graph._nodes ?? []) {
                const p = pos.get(n._irName);
                if (p) n.pos = [p.x, p.y];
            }
            markGraphDirty(graph);
            graph.setDirtyCanvas(true, true);
            fit();
            on.changed?.();
        },
        undo: () => { history.undo(graph); on.changed?.(); },
        redo: () => { history.redo(graph); on.changed?.(); },
        record: () => { history.record(graph); on.changed?.(); },
        canUndo: () => history.canUndo(),
        canRedo: () => history.canRedo(),
        select,
    };
}

// A flow's own input or output. The pseudo types are registered by importFlow
// the first time a flow is opened, which has always happened by the time
// anybody can press the button that calls this.
function newPseudo(graph, kind, LiteGraph, view) {
    const node = LiteGraph.createNode(
        kind === 'input' ? 'wireon/flow-input' : 'wireon/flow-output');
    if (!node) throw new Error('open a flow first');
    node._irKind = `pseudo-${kind}`;
    node._irName = freeName(graph, kind === 'input' ? 'Input' : 'Output');
    node.title = node._irName;
    // Inside what is shown: an input at the left edge, an output at the right.
    const [x, y, w] = view?.visible_area ?? [0, 0, 840];
    node.pos = [kind === 'input' ? x + 40 : x + Math.max(240, w - 220),
        y + 40 + (graph._nodes?.length ?? 0) * 50];
    graph.add(node);
    markGraphDirty(graph);
    return node;
}

// A block this world has no plugin for is drawn hatched and kept exactly as it
// came; the player is told rather than left to notice.
function sayUnknown(warnings, on) {
    const unknown = (warnings ?? []).filter((w) => w.startsWith('unknown block'));
    if (unknown.length) on.trouble?.(unknown.join(' \u00b7 '));
}

// Selecting one node, or none. litegraph's own callbacks fire for a click on
// the canvas; this is the same thing from the code's side.
function selecting(view, on) {
    return (node) => {
        view.deselectAllNodes?.();
        if (node) view.selectNode?.(node);
        on.selected?.(node ?? null);
    };
}

export function mountCanvas(host, { LiteGraph, LGraph, LGraphCanvas }, on = {}) {
    const { bench, wrap, canvasEl } = makeCanvas(host, on.bench);
    const graph = new LGraph();
    const view = new LGraphCanvas(canvasEl, graph);
    dress(view, graph);
    attachSubgraphChrome(view, wrap);
    watchDragsForLayout(view);

    const fit = () => {
        const r = wrap.getBoundingClientRect();
        canvasEl.width = Math.max(1, Math.round(r.width));
        canvasEl.height = Math.max(1, Math.round(r.height));
        view.resize?.(canvasEl.width, canvasEl.height);
        graph.setDirtyCanvas(true, true);
    };
    new ResizeObserver(fit).observe(wrap);


    const select = selecting(view, on);
    const addPseudo = (kind) => newPseudo(graph, kind, LiteGraph, view);
    const put = (block, point) => {
        // A drop is a pointer event's doing, so anything thrown in here has
        // nowhere to go but the bar: a block that cannot be made must say so
        // rather than leave the player pressing a line that does nothing.
        try {
            const node = newNode(graph, block, LiteGraph, graphPoint(view, canvasEl, point));
            on.placed?.(node); markGraphDirty(graph);
            select(node);
            return node;
        } catch (err) {
            on.trouble?.(String(err?.message ?? err));
            return null;
        }
    };
    const palette = mountPalette(bench, { onDrop: put, onRefresh: on.refreshBlocks });
    wireDrop(wrap, palette, put, on.files);

    let hash = '';
    function load(flow, { keep = false, layout = null } = {}) {
        if (!keep) {
            hash = flowHash(flow);
            setLayout(layout, () => on.changed?.());
        }
        graph.clear();
        const { warnings } = importFlow(flow, getBlock, LiteGraph, graph, '', hash);
        applyHiddenFlags(graph);
        fit();
        if (!keep) history.init(graph);
        on.changed?.();
        on.selected?.(null);
        sayUnknown(warnings, on);
    }
    const history = makeHistory(graph, (flow) => load(flow, { keep: true }),
        () => on.changed?.());

    // litegraph reports selection through callbacks rather than events.
    view.onNodeSelected = (node) => on.selected?.(node);
    view.onNodeDeselected = () => on.selected?.(null);
    view.onSubgraphOpen = () => on.scope?.();
    view.onSubgraphClose = () => on.scope?.();

    // The breadcrumb into a subflow is attachSubgraphChrome's own element,
    // appended to the wrapper it was given (`.subgraph-breadcrumb`).
    return handle({ node: host, graph, view, palette, history, load, select, LiteGraph,
        fit, addPseudo, wrap, crumb: () => wrap.querySelector('.subgraph-breadcrumb') }, on);
}
