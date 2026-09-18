// @ts-check
// Copied from wireon-process-editor tests/elx-nets.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 6 — net classification tests.

import { parseElx } from "/flow/elx/parse.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { classifyNets, basePortName, directionOf, buildScopeIndex } from "/flow/elx/nets.js";

const g = /** @type {any} */ (window);

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

g.test("nets: basePortName strips [N]", () => {
  g.assertEq(basePortName("in [0]"), "in");
  g.assertEq(basePortName("in [12]"), "in");
  g.assertEq(basePortName("json"), "json");
  g.assertEq(basePortName("list [out]"), "list [out]", "no digits -> not a port_group");
});

g.test("nets: classifyNets sees pseudo-input as a source", async () => {
  clear();
  registerPlugin(parsePlugin(await fetchText("/flow/palette/plugins/filesystem/plugin.xml")));
  registerPlugin(parsePlugin(await fetchText("/flow/palette/plugins/builtin/plugin.xml")));
  registerPlugin(parsePlugin(await fetchText("/flow/palette/plugins/http/plugin.xml")));

  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const classified = classifyNets(flow, getBlock);
  const n006 = classified.find((/** @type {any} */ n) => n.name === "N006");
  if (!n006) throw new Error("N006 not found");
  // N006 connects Target (pseudo-input) and Get First (NodeInstance.list input).
  g.assertEq(n006.source?.node, "Target", "pseudo-input is the source");
  g.assertEq(n006.sinks.length, 1, "single sink");
  g.assertEq(n006.warnings, [], "no warnings");
});

g.test("nets: subflow outer slot direction matches body pseudo-node", async () => {
  clear();
  // Don't need plugin registry for subflow classification — direction
  // is inferred from the inner pseudo-nodes alone.
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const idx = buildScopeIndex(flow);
  // Filter List exposes "list [in]" as outer input (subflow inner pseudo-input)
  // and "list [out]" as outer output (subflow inner pseudo-output).
  g.assertEq(directionOf({ node: "Filter List", port: "list [in]" }, idx, () => null), "in");
  g.assertEq(directionOf({ node: "Filter List", port: "list [out]" }, idx, () => null), "out");
});

g.test("nets: malformed net (no source) is flagged but still returned", () => {
  /** @type {any} */
  const flow = {
    engine: { type: "flow", maxSteps: 0, recordHistory: false },
    inputs: [], outputs: [{ kind: "output", name: "out" }],
    nodes: [], subflows: [],
    nets: [
      { name: "N1", connections: [
        { node: "out", port: "port" },
        { node: "out", port: "port" },
      ] },
    ],
  };
  const c = classifyNets(flow, () => null);
  g.assertEq(c[0].source, null);
  g.assertEq(c[0].sinks.length, 2);
  g.assertEq(c[0].warnings[0], "no source connection");
});
