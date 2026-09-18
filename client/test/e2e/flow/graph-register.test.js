// @ts-check
// Copied from wireon-process-editor tests/graph-register.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 5 — litegraph node-type registration tests.
//
// Litegraph is loaded as a classic script by tests.html (it attaches
// LiteGraph/LGraph/LGraphCanvas to window). These tests read it from
// the global directly.

import { parsePlugin } from "/flow/plugins/parse.js";
import {
  registerBlock,
  registerPlugin as registerPluginInGraph,
  typeName,
  isValidConnection,
} from "/flow/graph/register.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

g.test("registerBlock: type name layout", () => {
  /** @type {any} */
  const block = {
    id: "render", plugin: "json", groupPath: [],
    name: "Render Template", descriptions: {}, parameters: [],
    inputs: [], outputs: [],
  };
  g.assertEq(typeName(block), "json/render");
  /** @type {any} */
  const nested = { ...block, groupPath: ["array"] };
  g.assertEq(typeName(nested), "json/array/render");
});

g.test("registerBlock: instantiates with correct slot and widget counts", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  registerPluginInGraph(def, LG);

  const ctor = LG.registered_node_types["json/template-render"];
  if (!ctor) throw new Error("template-render not registered");

  const node = LG.createNode("json/template-render");
  g.assertEq(node.title, "Render Template", "title from BlockDef.name");
  g.assertEq(node.inputs.length, 2, "template + json");
  g.assertEq(node.outputs.length, 2, "string + error");
  g.assertEq(node.widgets.length, 2, "two parameter widgets");

  // input slot type encodes union of value ids.
  const tmpl = node.inputs[0];
  g.assertEq(tmpl.name, "template");
  g.assertEq(tmpl.type, "string,filesystem path", "union slot type");

  const json = node.inputs[1];
  g.assertEq(json.name, "json");
  g.assertEq(json.type, "json");

  // Output: 'error' uses value id 'error-code'.
  const errOut = node.outputs[1];
  g.assertEq(errOut.name, "error");
  g.assertEq(errOut.type, "error-code");
});

g.test("registerBlock: widget types follow parameter value id", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  registerPluginInGraph(def, LG);

  const tr = LG.createNode("json/template-render");
  // both params are boolean -> toggle widgets
  g.assertEq(tr.widgets[0].type, "toggle", "trim-blocks is a toggle");
  g.assertEq(tr.widgets[0].value, true, "trim-blocks default true");
  g.assertEq(tr.widgets[1].type, "toggle", "left-strip-blocks is a toggle");
  g.assertEq(tr.widgets[1].value, false, "left-strip-blocks default false");
  // properties mirror the widget value, keyed by parameter id.
  g.assertEq(tr.properties["trim-blocks"], true);
  g.assertEq(tr.properties["left-strip-blocks"], false);

  // to-string: integer parameter -> number widget
  const ts = LG.createNode("json/to-string");
  g.assertEq(ts.widgets.length, 1);
  g.assertEq(ts.widgets[0].type, "number");
  g.assertEq(ts.widgets[0].value, 4, "default 4");
  g.assertEq(ts.properties["indentation"], 4);
});

g.test("registerBlock: wildcard slot for ports with no <value>", async () => {
  // filesystem `path.exists` has bare <input name="path"/> and
  // <output name="exists"/> — no value children -> "*".
  const def = parsePlugin(await fetchText("/flow/palette/plugins/filesystem/plugin.xml"));
  registerPluginInGraph(def, LG);

  const node = LG.createNode("filesystem/path/exists");
  g.assertEq(node.inputs[0].type, "*", "bare input -> wildcard");
  g.assertEq(node.outputs[0].type, "*", "bare output -> wildcard");
});

g.test("registerBlock: category is derived from plugin/group path", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  registerPluginInGraph(def, LG);

  const ctor = LG.registered_node_types["json/array/append"];
  // litegraph sets ctor.category = type up to the last "/"
  g.assertEq(ctor.category, "json/array");
});

g.test("registerBlock: re-registering replaces (litegraph logs but does not throw)", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  registerPluginInGraph(def, LG);
  // Idempotent.
  registerPluginInGraph(def, LG);
  const ctor = LG.registered_node_types["json/template-render"];
  if (!ctor) throw new Error("re-registration lost the type");
});

// ---------------------------------------------------------------------------
// isValidConnection
// ---------------------------------------------------------------------------

g.test("isValidConnection: same structure, same value -> ok", () => {
  const out = { name: "x", structures: [{ id: "droplet" }], values: [{ id: "string" }] };
  const inn = { name: "y", structures: [{ id: "droplet" }], values: [{ id: "string" }] };
  if (!isValidConnection(out, inn)) throw new Error("expected ok");
});

g.test("isValidConnection: structure mismatch -> false", () => {
  const out = { name: "x", structures: [{ id: "list" }], values: [{ id: "string" }] };
  const inn = { name: "y", structures: [{ id: "droplet" }], values: [{ id: "string" }] };
  if (isValidConnection(out, inn)) throw new Error("expected reject on structure mismatch");
});

g.test("isValidConnection: value union overlap -> ok", () => {
  const out = { name: "x", structures: [{ id: "droplet" }], values: [{ id: "string" }] };
  const inn = {
    name: "y",
    structures: [{ id: "droplet" }],
    values: [{ id: "string" }, { id: "filesystem path" }],
  };
  if (!isValidConnection(out, inn)) throw new Error("expected ok on value-union overlap");
});

g.test("isValidConnection: value disjoint -> false", () => {
  const out = { name: "x", structures: [{ id: "droplet" }], values: [{ id: "json" }] };
  const inn = { name: "y", structures: [{ id: "droplet" }], values: [{ id: "string" }] };
  if (isValidConnection(out, inn)) throw new Error("expected reject on disjoint values");
});

g.test("isValidConnection: 'any' input (no values declared) accepts everything", () => {
  const out = { name: "x", structures: [{ id: "droplet" }], values: [{ id: "json" }] };
  const inn = { name: "y", structures: [{ id: "droplet" }], values: [] };
  if (!isValidConnection(out, inn)) throw new Error("expected 'any' to accept");
});

g.test("isValidConnection: missing ports degrade to permissive", () => {
  const out = { name: "x", structures: [{ id: "droplet" }], values: [{ id: "json" }] };
  if (!isValidConnection(undefined, out)) throw new Error("undefined -> permit");
  if (!isValidConnection(out, undefined)) throw new Error("undefined -> permit");
});
