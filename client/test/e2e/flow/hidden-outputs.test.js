// @ts-check
// Copied from wireon-process-editor tests/hidden-outputs.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 18.3 — hidden output ports: sidecar persistence + render flags.

import { saveHiddenOutputs, loadHiddenOutputs } from "/flow/graph/layoutstore.js";
import {
  isOutputHidden,
  setOutputHidden,
  applyHiddenOutputFlags,
} from "/flow/graph/hideoutputs.js";

const g = /** @type {any} */ (window);

const HASH = "test-hash-18";
const SCOPE = "";

g.test("hidden-outputs sidecar: save then load round-trips a set", () => {
  saveHiddenOutputs(HASH, SCOPE, "My Node", ["error", "debug"]);
  const map = loadHiddenOutputs(HASH, SCOPE);
  const set = map.get("My Node");
  g.assertEq(!!set, true);
  g.assertEq(set.has("error"), true);
  g.assertEq(set.has("debug"), true);
  // An empty list removes the entry.
  saveHiddenOutputs(HASH, SCOPE, "My Node", []);
  g.assertEq(loadHiddenOutputs(HASH, SCOPE).has("My Node"), false);
});

g.test("hidden-outputs: setOutputHidden / isOutputHidden toggle the node set", () => {
  const node = { outputs: [{ name: "string" }, { name: "error" }] };
  g.assertEq(isOutputHidden(node, "error"), false);
  setOutputHidden(node, "error", true);
  g.assertEq(isOutputHidden(node, "error"), true);
  setOutputHidden(node, "error", false);
  g.assertEq(isOutputHidden(node, "error"), false);
});

g.test("hidden-outputs: applyHiddenOutputFlags marks links from hidden outputs", () => {
  const src = {
    id: 1,
    outputs: [{ name: "string" }, { name: "error" }],
    _hiddenOutputs: new Set(["error"]),
  };
  const graph = {
    _nodes: [src],
    links: {
      10: { origin_id: 1, origin_slot: 0 }, // from "string" — visible
      11: { origin_id: 1, origin_slot: 1 }, // from "error"  — hidden
    },
  };
  applyHiddenOutputFlags(graph);
  g.assertEq(graph.links[10]._hiddenByOutput, false);
  g.assertEq(graph.links[11]._hiddenByOutput, true);

  // Un-hiding clears the flag on the next pass.
  src._hiddenOutputs.delete("error");
  applyHiddenOutputFlags(graph);
  g.assertEq(graph.links[11]._hiddenByOutput, false);
});
