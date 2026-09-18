// @ts-check
// Copied from wireon-process-editor tests/graph-import.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 6 — flow IR -> litegraph LGraph importer tests.
//
// Litegraph is loaded as a classic script by tests.html.

import { parseElx } from "/flow/elx/parse.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

const PLUGINS = [
  "builtin", "filesystem", "http", "json", "mathematics",
  "opencv", "strings",
];

async function setupRegistry() {
  clear();
  for (const id of PLUGINS) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

g.test("importFlow: file-response renders all entities without warnings", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const { graph, warnings, linkToNet } = importFlow(flow, getBlock, LG);

  g.assertEq(warnings, [], "no warnings");
  // 2 inputs + 1 output + 4 nodes = 7
  g.assertEq(graph._nodes.length, 7, "node count");
  // 6 nets each with 1 source and 1 sink -> 6 links.
  g.assertEq(Object.keys(graph.links).length, 6, "link count");
  // linkToNet should map every emitted link id back to its net name.
  g.assertEq(linkToNet.size, 6, "linkToNet size");
});

g.test("importFlow: create-albumlist top-level renders 27 nodes / 28 links", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph, warnings } = importFlow(flow, getBlock, LG);
  g.assertEq(warnings, [], "no warnings");
  // 2 inputs + 2 outputs + 20 nodes + 3 subflows = 27
  g.assertEq(graph._nodes.length, 27);
  g.assertEq(Object.keys(graph.links).length, 28);
});

g.test("importFlow: parameter override is applied to widget + property", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);

  // Top-level Concatenate has `<parameter id="separator">` with empty string.
  const concat = graph._nodes.find((/** @type {any} */ n) => n._irName === "Concatenate");
  if (!concat) throw new Error("Concatenate node not found");
  g.assertEq(concat.properties.separator, "", "empty separator applied");

  // Entries node carries parameter `recursive=false`.
  const entries = graph._nodes.find((/** @type {any} */ n) => n._irName === "Entries");
  g.assertEq(entries?.properties.recursive, false, "recursive parameter applied");
});

g.test("importFlow: port_group input is expanded into bracket-indexed slots", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  // Concatenate has port_group size 5.
  const concat = graph._nodes.find((/** @type {any} */ n) => n._irName === "Concatenate");
  const inputs = concat?.inputs || [];
  const groupIns = inputs.filter((/** @type {any} */ s) => s.name.startsWith("in ["));
  g.assertEq(groupIns.length, 5, "5 bracket-indexed inputs");
  g.assertEq(inputs[0].name, "in [0]");
});

g.test("importFlow: constant on an unwired output port (Write.error) is stashed", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const write = graph._nodes.find((/** @type {any} */ n) => n._irName === "Write");
  if (!write) throw new Error("Write node not found");
  const errOut = write.outputs.find((/** @type {any} */ s) => s.name === "error");
  // Empty <constant port="error"/> -> sentinel null on the slot.
  g.assertEq(errOut._constant, null, "empty constant stored as null sentinel");
});

g.test("importFlow: subflow node exposes its body's pseudo-nodes as outer slots", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const fl = graph._nodes.find((/** @type {any} */ n) => n._irName === "Filter List");
  if (!fl) throw new Error("Filter List subflow not found");
  g.assertEq(fl._irKind, "subflow");
  g.assertEq(
    fl.inputs.map((/** @type {any} */ s) => s.name),
    ["list [in]", "droplet [in]", "index"]
  );
  g.assertEq(
    fl.outputs.map((/** @type {any} */ s) => s.name),
    ["list [out]", "keep"]
  );
});

g.test("importFlow: subflow node carries an inner graph populated with its body", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const filterList = graph._nodes.find((/** @type {any} */ n) => n._irName === "Filter List");
  if (!filterList) throw new Error("Filter List subflow not found");
  // Inner subgraph exists and matches litegraph's expected shape.
  if (!filterList.subgraph) throw new Error("subgraph property missing");
  g.assertEq(filterList.subgraph._is_subgraph, true);
  if (filterList.subgraph._subgraph_node !== filterList) {
    throw new Error("inner _subgraph_node back-reference wrong");
  }
  // The body has 3 pseudo-inputs, 2 pseudo-outputs, plus inner block nodes.
  // It also contains an OR node and a Get Last node among others; only
  // assert the lower bound and the presence of the pseudo-inputs.
  const innerNodes = filterList.subgraph._nodes;
  if (innerNodes.length < 5) {
    throw new Error("inner subgraph looks empty: " + innerNodes.length + " nodes");
  }
  const names = innerNodes.map((/** @type {any} */ n) => n._irName);
  for (const expected of ["list [in]", "droplet [in]", "index", "list [out]", "keep"]) {
    if (!names.includes(expected)) {
      throw new Error("inner pseudo-node " + expected + " missing");
    }
  }
});

g.test("importFlow: subflow onDblClick is wired", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const filterList = graph._nodes.find((/** @type {any} */ n) => n._irName === "Filter List");
  if (!filterList) throw new Error("Filter List subflow not found");
  if (typeof filterList.onDblClick !== "function") {
    throw new Error("onDblClick handler not installed");
  }
});

g.test("importFlow: positions are assigned from auto-layout", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  for (const n of graph._nodes) {
    if (!Array.isArray(n.pos) && !(n.pos && n.pos.length === 2)) {
      throw new Error("node " + n.title + " missing pos");
    }
    if (n.pos[0] === 0 && n.pos[1] === 0) {
      throw new Error("node " + n.title + " sat at origin (no layout applied)");
    }
  }
});

g.test("importFlow: unknown block falls back to a placeholder with a warning", async () => {
  await setupRegistry();
  /** @type {any} */
  const flow = {
    engine: { type: "flow", maxSteps: 0, recordHistory: false },
    inputs: [], outputs: [], subflows: [], nets: [],
    nodes: [
      { id: "no.such-block", plugin: "unknown-plugin", name: "Mystery",
        parameters: [], constants: [], portGroups: [] },
    ],
  };
  const { graph, warnings } = importFlow(flow, getBlock, LG);
  g.assertEq(graph._nodes.length, 1);
  g.assertEq(graph._nodes[0]._irPlaceholder, true);
  if (!warnings.some((/** @type {any} */ w) => w.includes("unknown block"))) {
    throw new Error("expected an 'unknown block' warning");
  }
});
