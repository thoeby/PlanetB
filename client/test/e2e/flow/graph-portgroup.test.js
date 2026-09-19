// @ts-check
// Copied from wireon-process-editor tests/graph-portgroup.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples; and the two tests that
// look for the OR node walk into the subflow it is in. They were red at the
// source: the sample moved OR inside <filter name="Filter List"> and a search
// of graph._nodes alone has not found it since. The assertions themselves are
// untouched — that is the point of running them here.
// Phase 8 — variable-arity port_group +/- controls.
//
// Snapshot of an OR node growing from size 2 to size 4 and shrinking
// back to 2. Also exercises the conservative removal rule (last slot
// must be unwired) and the discovery-by-block path for nodes spawned
// from the palette (no <port_group> instance present yet).

import { parseElx } from "/flow/elx/parse.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";
import { addPort, removePort } from "/flow/graph/portgroup.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

const PLUGINS = ["builtin", "filesystem", "http", "json", "mathematics", "opencv", "strings"];

/**
 * A node by name, anywhere in the flow: the top level first, then the inner
 * graph of every subflow node, depth first.
 *
 * @param {any} graph
 * @param {string} name
 */
function findNode(graph, name) {
  for (const n of graph._nodes || []) if (n._irName === name) return n;
  for (const n of graph._nodes || []) {
    if (n.subgraph) {
      const found = findNode(n.subgraph, name);
      if (found) return found;
    }
  }
  return null;
}

async function setupRegistry() {
  clear();
  for (const id of PLUGINS) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

g.test("portgroup: OR(3) grows to 5 and shrinks back to 3", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);

  // OR is the mathematics.logic.or with port_group size 3, in Filter List.
  const or = findNode(graph, "OR");
  if (!or) throw new Error("OR node not found");

  // Snapshot a: starting state.
  g.assertEq(or.inputs.length, 3);
  g.assertEq(or.inputs.map((/** @type {any} */ s) => s.name), ["in [0]", "in [1]", "in [2]"]);
  const state = or._portGroups.find((/** @type {any} */ s) => s.id === "in");
  g.assertEq(state.size, 3);

  // Grow to 5.
  g.assertEq(addPort(or, "in"), 4);
  g.assertEq(addPort(or, "in"), 5);
  g.assertEq(or.inputs.map((/** @type {any} */ s) => s.name),
    ["in [0]", "in [1]", "in [2]", "in [3]", "in [4]"]);

  // Shrink: in [4] is unwired, in [3] is unwired, so both removals succeed.
  g.assertEq(removePort(or, "in"), 4);
  g.assertEq(removePort(or, "in"), 3);
  g.assertEq(or.inputs.length, 3);
  g.assertEq(state.size, 3);
});

g.test("portgroup: removal refuses when last slot is still wired", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const or = findNode(graph, "OR");
  if (!or) throw new Error("OR node not found");
  // OR is fed by Contains 1/2/3 in the sample — its three slots are all wired.
  for (const s of or.inputs) {
    if (s.link == null) throw new Error("expected " + s.name + " to be wired");
  }
  // Refuses with sentinel -3.
  g.assertEq(removePort(or, "in"), -3);
  g.assertEq(or.inputs.length, 3, "no slot removed");
});

g.test("portgroup: removal refuses when at the declared minimum", async () => {
  await setupRegistry();
  // mathematics/logic/or declares `<input name="in" type="group" min="2">`.
  // Spawning from the palette starts at min size with no port_group instance.
  const or = LG.createNode("mathematics/logic/or");
  if (!or) throw new Error("mathematics/logic/or not registered");
  const state = or._portGroups.find((/** @type {any} */ s) => s.id === "in");
  g.assertEq(state.min, 2);
  // Grow by 1 then attempt to shrink twice — second call hits the min.
  addPort(or, "in");
  g.assertEq(removePort(or, "in"), 2);
  g.assertEq(removePort(or, "in"), -2, "blocked at min");
});

g.test("portgroup: palette-spawned OR has +/- widgets attached", () => {
  const or = LG.createNode("mathematics/logic/or");
  if (!or) throw new Error("mathematics/logic/or not registered");
  const tags = (or.widgets || [])
    .map((/** @type {any} */ w) => w.options && w.options._portGroupTag)
    .filter((/** @type {any} */ t) => typeof t === "string");
  // Two widgets (+, −) per group.
  g.assertEq(tags.length, 2);
});
