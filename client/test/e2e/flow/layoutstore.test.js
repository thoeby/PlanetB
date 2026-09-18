// @ts-check
// Copied from wireon-process-editor tests/layout-sidecar.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them, where
// the store is flow.layout in the world rather than localStorage) and the
// fixtures from /flow/palette and /flow/samples; and the override test names a
// node the sample actually has. It was red at the source: file-response.elx has
// had no node called "Source" for some time. The assertions are otherwise
// untouched — that is the point of running them here.
// Phase 9 — layout sidecar persistence.

import { parseElx } from "/flow/elx/parse.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";
import {
  fnv1a, flowHash, loadOverrides, saveNodePosition, clearScope,
} from "/flow/graph/layoutstore.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

g.test("fnv1a: known vectors", () => {
  // Standard FNV-1a vectors.
  g.assertEq(fnv1a(""), "811c9dc5");
  g.assertEq(fnv1a("a"), "e40c292c");
  g.assertEq(fnv1a("foobar"), "bf9cf968");
});

g.test("flowHash: stable across structurally-equal parses", async () => {
  const xml = await fetchText("/flow/samples/file-response.elx");
  const a = flowHash(parseElx(xml));
  const b = flowHash(parseElx(xml));
  g.assertEq(a, b);
  // Sanity: 8-char hex.
  if (!/^[0-9a-f]{8}$/.test(a)) throw new Error("hash is not 8-char hex: " + a);
});

g.test("loadOverrides / saveNodePosition: round-trip through the layout store", () => {
  const h = "test1234";
  clearScope(h, "");
  g.assertEq(loadOverrides(h, "").size, 0, "starts empty");
  saveNodePosition(h, "", "A", { x: 10, y: 20 });
  saveNodePosition(h, "", "B", { x: 99, y: 50 });
  const back = loadOverrides(h, "");
  g.assertEq(back.size, 2);
  g.assertEq(back.get("A"), { x: 10, y: 20 });
  g.assertEq(back.get("B"), { x: 99, y: 50 });
  clearScope(h, "");
});

g.test("importFlow: applies saved overrides on top of auto-layout", async () => {
  clear();
  for (const id of ["builtin", "filesystem", "http", "json", "strings"]) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const h = flowHash(flow);
  clearScope(h, "");
  // First import sets nothing — but we then save a position, re-import,
  // and expect that position back on the node.
  saveNodePosition(h, "", "Append", { x: 1234, y: 567 });
  const { graph } = importFlow(flow, getBlock, LG);
  const src = graph._nodes.find((/** @type {any} */ n) => n._irName === "Append");
  if (!src) throw new Error("Append node not found");
  g.assertEq(src.pos[0], 1234);
  g.assertEq(src.pos[1], 567);
  clearScope(h, "");
});
