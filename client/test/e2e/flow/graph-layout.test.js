// @ts-check
// Copied from wireon-process-editor tests/graph-layout.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here — except the layer width,
// which is this copy's 300 (client/flow/graph/layout.js) and not the
// reference's 220.
// Phase 6 — layered layout tests.

import { layout } from "/flow/graph/layout.js";

const g = /** @type {any} */ (window);

g.test("layout: pseudo-input at x=LEFT_PAD, pseudo-output rightmost", () => {
  /** @type {any} */
  const flow = {
    engine: { type: "flow", maxSteps: 0, recordHistory: false },
    inputs: [{ kind: "input", name: "in1" }],
    outputs: [{ kind: "output", name: "out1" }],
    nodes: [
      { id: "a", plugin: "p", name: "A", parameters: [], constants: [], portGroups: [] },
      { id: "b", plugin: "p", name: "B", parameters: [], constants: [], portGroups: [] },
    ],
    subflows: [],
    nets: [
      { name: "n1", connections: [{ node: "in1", port: "port" }, { node: "A", port: "x" }] },
      { name: "n2", connections: [{ node: "A", port: "y" }, { node: "B", port: "x" }] },
      { name: "n3", connections: [{ node: "B", port: "y" }, { node: "out1", port: "port" }] },
    ],
  };
  /** @param {string} _p @param {string} pid */
  const getBlock = (_p, pid) => ({
    id: pid, plugin: "p", groupPath: [], name: pid, descriptions: {},
    parameters: [], inputs: [{ name: "x", structures: [], values: [] }], outputs: [{ name: "y", structures: [], values: [] }],
  });
  const pos = layout(flow, getBlock);
  // in1 at layer 0, A at 1, B at 2, out1 at layer 3.
  g.assertEq(pos.get("in1")?.x, 40, "in1 x");
  g.assertEq(pos.get("A")?.x, 40 + 300, "A x");
  g.assertEq(pos.get("B")?.x, 40 + 600, "B x");
  g.assertEq(pos.get("out1")?.x, 40 + 900, "out1 x");
});

g.test("layout: parallel branches stack vertically in their layer", () => {
  /** @type {any} */
  const flow = {
    engine: { type: "flow", maxSteps: 0, recordHistory: false },
    inputs: [{ kind: "input", name: "src" }],
    outputs: [],
    nodes: [
      { id: "x", plugin: "p", name: "X", parameters: [], constants: [], portGroups: [] },
      { id: "x", plugin: "p", name: "Y", parameters: [], constants: [], portGroups: [] },
    ],
    subflows: [],
    nets: [
      { name: "n1", connections: [{ node: "src", port: "port" }, { node: "X", port: "x" }] },
      { name: "n2", connections: [{ node: "src", port: "port" }, { node: "Y", port: "x" }] },
    ],
  };
  /** @param {string} _p @param {string} pid */
  const getBlock = (_p, pid) => ({
    id: pid, plugin: "p", groupPath: [], name: pid, descriptions: {},
    parameters: [], inputs: [{ name: "x", structures: [], values: [] }], outputs: [],
  });
  const pos = layout(flow, getBlock);
  // X and Y share layer 1; they should differ in y.
  g.assertEq(pos.get("X")?.x, pos.get("Y")?.x, "same layer same x");
  if (pos.get("X")?.y === pos.get("Y")?.y) throw new Error("parallel siblings collided in y");
});
