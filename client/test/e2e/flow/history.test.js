// @ts-check
// Copied from wireon-process-editor tests/history.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 22.3 — undo/redo.
//
// The pure stack (injected serialize/restore) is tested directly. A second
// block exercises the real ELX serialize/restore against the sample so the
// three required change classes — net topology, port-group resize, and
// constant edits — are shown to round-trip through undo/redo.

import {
  createHistory,
  attachHistory,
  getHistory,
  markGraphDirty,
} from "/flow/graph/history.js";
import { parseElx } from "/flow/elx/parse.js";
import { serializeElx } from "/flow/elx/serialize.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear as clearRegistry } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";
import { exportFlow } from "/flow/graph/export.js";
import { addPort } from "/flow/graph/portgroup.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

// ---------------------------------------------------------------------------
// Pure stack
// ---------------------------------------------------------------------------

/** @param {{state: string}} graph @param {() => void} [onChange] */
function strHistory(graph, onChange) {
  return createHistory({
    serialize: (gr) => gr.state,
    restore: (gr, snap) => { gr.state = snap; },
    onChange,
  });
}

g.test("history: record/undo/redo walks the stack", () => {
  const graph = { state: "A" };
  const h = strHistory(graph);
  h.init(graph);
  g.assertEq(h.canUndo(), false);

  graph.state = "B"; h.record(graph);
  graph.state = "C"; h.record(graph);
  g.assertEq(h.canUndo(), true);

  h.undo(graph); g.assertEq(graph.state, "B");
  h.undo(graph); g.assertEq(graph.state, "A");
  g.assertEq(h.canUndo(), false);

  h.redo(graph); g.assertEq(graph.state, "B");
  h.redo(graph); g.assertEq(graph.state, "C");
  g.assertEq(h.canRedo(), false);
});

g.test("history: identical snapshot is not recorded", () => {
  const graph = { state: "A" };
  const h = strHistory(graph);
  h.init(graph);
  h.record(graph); // unchanged
  g.assertEq(h.canUndo(), false);
});

g.test("history: a new edit after undo clears the redo stack", () => {
  const graph = { state: "A" };
  const h = strHistory(graph);
  h.init(graph);
  graph.state = "B"; h.record(graph);
  graph.state = "C"; h.record(graph);
  h.undo(graph); // back to B
  g.assertEq(h.canRedo(), true);
  graph.state = "D"; h.record(graph);
  g.assertEq(h.canRedo(), false);
  h.undo(graph); g.assertEq(graph.state, "B");
});

g.test("history: depth is capped by limit", () => {
  const graph = { state: "0" };
  const h = createHistory({
    serialize: (gr) => gr.state,
    restore: (gr, s) => { gr.state = s; },
    limit: 2,
  });
  h.init(graph);
  for (let i = 1; i <= 5; i++) { graph.state = String(i); h.record(graph); }
  // Only the last 2 prior states are retained.
  h.undo(graph); g.assertEq(graph.state, "4");
  h.undo(graph); g.assertEq(graph.state, "3");
  g.assertEq(h.canUndo(), false);
});

g.test("history: restore runs with the controller suspended", () => {
  const graph = { state: "A" };
  let suspendedDuringRestore = null;
  const h = createHistory({
    serialize: (gr) => gr.state,
    restore: (gr, s) => { gr.state = s; suspendedDuringRestore = h.isSuspended(); },
  });
  h.init(graph);
  graph.state = "B"; h.record(graph);
  h.undo(graph);
  g.assertEq(suspendedDuringRestore, true);
  g.assertEq(h.isSuspended(), false);
});

g.test("history: markGraphDirty coalesces a burst into one snapshot", async () => {
  const graph = { state: "A" };
  const h = strHistory(graph);
  attachHistory(graph, h);
  g.assertEq(getHistory(graph) === h, true);

  graph.state = "B"; markGraphDirty(graph);
  graph.state = "C"; markGraphDirty(graph); // coalesced
  await new Promise((r) => setTimeout(r, 0));

  g.assertEq(h.canUndo(), true);
  h.undo(graph);
  g.assertEq(graph.state, "A"); // single entry: C -> A
  g.assertEq(h.canUndo(), false);
});

// ---------------------------------------------------------------------------
// Integration: ELX serialize/restore against the sample
// ---------------------------------------------------------------------------

const PLUGINS = ["builtin", "filesystem", "http", "json", "mathematics", "opencv", "strings"];

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return r.text();
}

async function setupRegistry() {
  clearRegistry();
  for (const id of PLUGINS) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

/**
 * Build an ELX-backed history bound to a graph, restoring into that same
 * graph (mirrors main.js's wiring).
 * @param {any} graph
 */
function elxHistory(graph) {
  const h = createHistory({
    serialize: (gr) => serializeElx(exportFlow(gr)),
    restore: (gr, elx) => {
      gr.clear();
      importFlow(parseElx(elx), getBlock, LG, gr);
    },
  });
  attachHistory(graph, h);
  return h;
}

g.test("history(elx): a removed connection round-trips through undo/redo", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const { graph } = importFlow(parseElx(src), getBlock, LG);
  const baseline = serializeElx(exportFlow(graph));
  const h = elxHistory(graph);

  const linkIds = Object.keys(graph.links || {});
  g.assertEq(linkIds.length > 0, true); // sample has wires
  const link = graph.links[linkIds[0]];
  const target = graph.getNodeById(link.target_id);
  target.disconnectInput(link.target_slot);

  const mutated = serializeElx(exportFlow(graph));
  g.assertEq(mutated !== baseline, true); // topology actually changed
  h.record(graph);

  h.undo(graph);
  g.assertEq(serializeElx(exportFlow(graph)), baseline);
  h.redo(graph);
  g.assertEq(serializeElx(exportFlow(graph)), mutated);
});

g.test("history(elx): a port-group resize round-trips through undo", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const { graph } = importFlow(parseElx(src), getBlock, LG);
  const baseline = serializeElx(exportFlow(graph));
  const h = elxHistory(graph);

  const node = (graph._nodes || []).find(
    (/** @type {any} */ n) => n._portGroups && n._portGroups.length
  );
  g.assertEq(!!node, true); // sample has a variable-arity node (OR / Concatenate)
  addPort(node, node._portGroups[0].id);

  const mutated = serializeElx(exportFlow(graph));
  g.assertEq(mutated !== baseline, true);
  h.record(graph);

  h.undo(graph);
  g.assertEq(serializeElx(exportFlow(graph)), baseline);
});

g.test("history(elx): a constant edit round-trips through undo", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const { graph } = importFlow(parseElx(src), getBlock, LG);
  const baseline = serializeElx(exportFlow(graph));
  const h = elxHistory(graph);

  // A PortConstant is { port, value: { structure, value: { id, data } } };
  // some are empty (intentionally unconnected) so find one with a value.
  let con = null;
  for (const n of graph._nodes || []) {
    if (!Array.isArray(n._irConstants)) continue;
    con = n._irConstants.find((/** @type {any} */ c) => c.value && c.value.value);
    if (con) break;
  }
  g.assertEq(!!con, true); // sample has at least one valued constant
  con.value.value.data = "__undo_test__" + (con.value.value.data || "");

  const mutated = serializeElx(exportFlow(graph));
  g.assertEq(mutated !== baseline, true);
  h.record(graph);

  h.undo(graph);
  g.assertEq(serializeElx(exportFlow(graph)), baseline);
});
