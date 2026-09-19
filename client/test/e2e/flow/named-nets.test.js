// @ts-check
// Copied from wireon-process-editor tests/named-nets.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 12 — named-net rendering polish.

import { parseElx } from "/flow/elx/parse.js";
import { serializeElx } from "/flow/elx/serialize.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";
import { exportFlow } from "/flow/graph/export.js";
import {
  isUserNamedNet, userNamedNets, getNetMode, setNetMode,
} from "/flow/graph/namednets.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

const PLUGINS = [
  "builtin", "filesystem", "http", "json", "mathematics", "opencv", "strings",
];

async function setupRegistry() {
  clear();
  for (const id of PLUGINS) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

g.test("named-nets: isUserNamedNet detects N\\d+ as auto", () => {
  g.assertEq(isUserNamedNet("N001"), false);
  g.assertEq(isUserNamedNet("N12345"), false);
  g.assertEq(isUserNamedNet("target"), true);
  g.assertEq(isUserNamedNet("my_net"), true);
  g.assertEq(isUserNamedNet(""), false);
});

g.test("named-nets: create-albumlist exposes 'target' as user-named", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph } = importFlow(flow, getBlock, LG);
  const named = userNamedNets(graph);
  g.assertEq(named, ["target"]);
});

g.test("named-nets: toggling a mode hides the link via _hidden", async () => {
  await setupRegistry();
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const { graph, linkToNet } = importFlow(flow, getBlock, LG);

  // Find at least one link belonging to the target net.
  let targetLinkId = -1;
  for (const [lid, nm] of linkToNet) {
    if (nm === "target") { targetLinkId = lid; break; }
  }
  if (targetLinkId < 0) throw new Error("could not locate 'target' net link");

  g.assertEq(graph.links[targetLinkId]._hidden, undefined, "wires by default");
  setNetMode(graph, "target", "labels");
  g.assertEq(getNetMode(graph, "target"), "labels");
  g.assertEq(graph.links[targetLinkId]._hidden, true, "labels mode hides the link");

  // Switching back clears the flag.
  setNetMode(graph, "target", "wires");
  g.assertEq(graph.links[targetLinkId]._hidden, false);
});

g.test("named-nets: toggling mode does NOT change export IR", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const flow = parseElx(src);
  const { graph } = importFlow(flow, getBlock, LG);
  // Flip mode and confirm the exported XML is still byte-equivalent.
  setNetMode(graph, "target", "labels");
  const out = serializeElx(exportFlow(graph));
  setNetMode(graph, "target", "wires");
  const out2 = serializeElx(exportFlow(graph));
  g.assertEq(out, out2, "mode toggle must not alter ELX export");
});
