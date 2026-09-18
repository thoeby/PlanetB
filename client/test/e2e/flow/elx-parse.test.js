// @ts-check
// Copied from wireon-process-editor tests/elx-parse.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 1 — parser tests against the two real sample exports.
//
// These tests run in the browser (tests.html) because parseElx uses
// the browser-native DOMParser. The runner exposes test/assertEq/
// assertThrows as globals; we just use them.

import { parseElx } from "/flow/elx/parse.js";

const g = /** @type {any} */ (window);

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

// ---------------------------------------------------------------------------
// file-response.elx — the small one
// ---------------------------------------------------------------------------

g.test("parseElx: file-response — top-level shape", async () => {
  const xml = await fetchText("/flow/samples/file-response.elx");
  const flow = parseElx(xml);

  g.assertEq(flow.engine.type, "flow", "engine.type");
  g.assertEq(flow.engine.maxSteps, 0, "engine.maxSteps");
  g.assertEq(flow.engine.recordHistory, false, "engine.recordHistory");

  g.assertEq(flow.inputs.length, 2, "input count");
  g.assertEq(flow.outputs.length, 1, "output count");
  g.assertEq(flow.nodes.length, 4, "node count");
  g.assertEq(flow.subflows.length, 0, "subflow count");
  g.assertEq(flow.nets.length, 6, "net count");
});

g.test("parseElx: file-response — pseudo-input carries a baked value", async () => {
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const target = flow.inputs.find((/** @type {any} */ p) => p.name === "Target");
  if (!target) throw new Error("input 'Target' not found");
  g.assertEq(target.kind, "input");
  g.assertEq(target.structure?.structure, "droplet", "Target structure id");
  g.assertEq(target.structure?.value?.id, "string", "Target value id");
  g.assertEq(target.structure?.value?.data, "css/cover.css", "Target value data");
  g.assertEq(target.structure?.value?.cdata, true, "Target uses CDATA");
});

g.test("parseElx: file-response — pseudo-input with non-CDATA filesystem path", async () => {
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const bp = flow.inputs.find((/** @type {any} */ p) => p.name === "Base Path");
  if (!bp) throw new Error("input 'Base Path' not found");
  g.assertEq(bp.structure?.value?.id, "filesystem path");
  g.assertEq(
    bp.structure?.value?.data,
    "C:/Users/portablimaschina/Documents/valaisplus/assets/"
  );
  // The source uses plain text for filesystem-path values, not CDATA.
  g.assertEq(bp.structure?.value?.cdata, undefined, "filesystem path is not CDATA");
});

g.test("parseElx: file-response — N006 connects Get First.list <- Target.port", async () => {
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const n006 = flow.nets.find((/** @type {any} */ n) => n.name === "N006");
  if (!n006) throw new Error("net N006 not found");
  g.assertEq(n006.connections, [
    { node: "Get First", port: "list" },
    { node: "Target", port: "port" },
  ]);
});

g.test("parseElx: file-response — Append has port_group size 2", async () => {
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const append = flow.nodes.find((/** @type {any} */ n) => n.name === "Append");
  if (!append) throw new Error("node 'Append' not found");
  g.assertEq(append.id, "path.append");
  g.assertEq(append.plugin, "filesystem");
  g.assertEq(append.portGroups.length, 1);
  g.assertEq(append.portGroups[0], { id: "in", size: 2 });
});

g.test("parseElx: file-response — HTTP File Response carries empty-string constant", async () => {
  const flow = parseElx(await fetchText("/flow/samples/file-response.elx"));
  const http = flow.nodes.find((/** @type {any} */ n) => n.name === "HTTP File Response");
  if (!http) throw new Error("node 'HTTP File Response' not found");
  g.assertEq(http.constants.length, 1);
  const c = http.constants[0];
  g.assertEq(c.port, "cache control");
  g.assertEq(c.value?.structure, "droplet");
  g.assertEq(c.value?.value?.id, "string");
  g.assertEq(c.value?.value?.data, "");
  g.assertEq(c.value?.value?.cdata, true, "empty CDATA is preserved as CDATA");
});

// ---------------------------------------------------------------------------
// create-albumlist.elx — the bigger one, with subflows and quirks
// ---------------------------------------------------------------------------

g.test("parseElx: create-albumlist — top-level shape", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));

  g.assertEq(flow.engine.type, "flow", "engine.type");
  g.assertEq(flow.engine.maxSteps, 0, "engine.maxSteps");
  g.assertEq(flow.engine.recordHistory, false, "engine.recordHistory");

  g.assertEq(flow.inputs.length, 2, "top-level input count");
  g.assertEq(flow.outputs.length, 2, "top-level output count");
  g.assertEq(flow.nodes.length, 20, "top-level node count");
  g.assertEq(flow.subflows.length, 3, "subflow count (2 filters + 1 transformation)");
  g.assertEq(flow.nets.length, 21, "top-level net count");
});

g.test("parseElx: create-albumlist — subflow kinds and order", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const kinds = flow.subflows.map((/** @type {any} */ s) => s.kind);
  // childrenEls preserves source order per element type; filters come
  // before the transformation in the bucket order we assemble.
  g.assertEq(kinds, ["filter", "filter", "transformation"]);
  const names = flow.subflows.map((/** @type {any} */ s) => s.name);
  g.assertEq(names, ["Filter List", "Filter List 2", "For-Each"]);
});

g.test("parseElx: create-albumlist — Filter List body has 3 inputs, 2 outputs, 6 nodes, 7 nets", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const fl = flow.subflows.find((/** @type {any} */ s) => s.name === "Filter List");
  if (!fl) throw new Error("subflow 'Filter List' not found");
  g.assertEq(fl.kind, "filter");
  g.assertEq(fl.id, "structures.list");
  g.assertEq(fl.type, "standalone");
  g.assertEq(fl.body.inputs.length, 3, "inner inputs");
  g.assertEq(fl.body.outputs.length, 2, "inner outputs");
  g.assertEq(fl.body.nodes.length, 6, "inner nodes");
  g.assertEq(fl.body.nets.length, 7, "inner nets");
});

g.test("parseElx: create-albumlist — Filter List preserves baked-in droplet [in] string", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const fl = flow.subflows.find((/** @type {any} */ s) => s.name === "Filter List");
  const droplet = fl.body.inputs.find((/** @type {any} */ p) => p.name === "droplet [in]");
  g.assertEq(droplet.structure?.structure, "droplet");
  g.assertEq(droplet.structure?.value?.id, "string");
  g.assertEq(
    droplet.structure?.value?.data,
    "C:/Users/portablimaschina/Music/ACDC/Back in Black/AC,DC - Back In Black.flac"
  );
});

g.test("parseElx: create-albumlist — invalid-structure sentinel survives", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const fl = flow.subflows.find((/** @type {any} */ s) => s.name === "Filter List");
  const listIn = fl.body.inputs.find((/** @type {any} */ p) => p.name === "list [in]");
  g.assertEq(listIn.structure?.structure, "invalid");
  g.assertEq(listIn.structure?.plugin, "", "plugin attr preserved even when empty");
  g.assertEq(listIn.structure?.value, undefined, "no <value> on invalid structure");
});

g.test("parseElx: create-albumlist — OR(3) port_group is parsed", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const fl = flow.subflows.find((/** @type {any} */ s) => s.name === "Filter List");
  const or = fl.body.nodes.find((/** @type {any} */ n) => n.name === "OR");
  if (!or) throw new Error("node 'OR' not found in Filter List");
  g.assertEq(or.id, "logic.or");
  g.assertEq(or.plugin, "mathematics");
  g.assertEq(or.portGroups, [{ id: "in", size: 3 }]);
});

g.test("parseElx: create-albumlist — 'target' is a user-named net wired to 4 endpoints", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const target = flow.nets.find((/** @type {any} */ n) => n.name === "target");
  if (!target) throw new Error("net 'target' not found");
  g.assertEq(target.connections, [
    { node: "Append", port: "in [0]" },
    { node: "Append 2", port: "in [0]" },
    { node: "Create Directory", port: "path" },
    { node: "target", port: "port" },
  ]);
});

g.test("parseElx: create-albumlist — empty <constant port=\"error\"/> survives", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const write = flow.nodes.find((/** @type {any} */ n) => n.name === "Write");
  if (!write) throw new Error("node 'Write' not found");
  const errConst = write.constants.find((/** @type {any} */ c) => c.port === "error");
  if (!errConst) throw new Error("constant port='error' not found on Write");
  g.assertEq(errConst.value, undefined, "empty <constant port='error'/> has no value");
});

g.test("parseElx: create-albumlist — quirky <value id=\"error-code\"> in For-Each survives verbatim", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const fe = flow.subflows.find((/** @type {any} */ s) => s.name === "For-Each");
  if (!fe) throw new Error("subflow 'For-Each' not found");
  const concat = fe.body.nodes.find((/** @type {any} */ n) => n.name === "Concatenate");
  if (!concat) throw new Error("node 'Concatenate' not found in For-Each");
  const in4 = concat.constants.find((/** @type {any} */ c) => c.port === "in [4]");
  if (!in4) throw new Error("constant port='in [4]' not found");
  g.assertEq(in4.value?.value?.id, "error-code", "preserve mis-tagged value id");
  g.assertEq(in4.value?.value?.data, "</td></tr>");
  g.assertEq(in4.value?.value?.cdata, true);
});

g.test("parseElx: create-albumlist — Entries parameter 'recursive' is boolean false", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const entries = flow.nodes.find((/** @type {any} */ n) => n.name === "Entries");
  if (!entries) throw new Error("node 'Entries' not found");
  g.assertEq(entries.parameters.length, 1);
  g.assertEq(entries.parameters[0].id, "recursive");
  g.assertEq(entries.parameters[0].value.id, "boolean");
  g.assertEq(entries.parameters[0].value.data, "false");
  // Booleans were authored without CDATA in the sample.
  g.assertEq(entries.parameters[0].value.cdata, undefined);
});

g.test("parseElx: create-albumlist — Concatenate(5) has 3 constants + 1 parameter + port_group", async () => {
  const flow = parseElx(await fetchText("/flow/samples/create-albumlist.elx"));
  const concat = flow.nodes.find((/** @type {any} */ n) => n.name === "Concatenate");
  if (!concat) throw new Error("top-level 'Concatenate' not found");
  g.assertEq(concat.constants.length, 3, "constants in [0], [2], [4]");
  g.assertEq(concat.parameters.length, 1, "parameter separator");
  g.assertEq(concat.parameters[0].id, "separator");
  g.assertEq(concat.parameters[0].value.data, "", "empty separator");
  g.assertEq(concat.portGroups, [{ id: "in", size: 5 }]);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

g.test("parseElx: rejects non-<elx> root", () => {
  let threw = false;
  try {
    parseElx("<not-elx/>");
  } catch (_e) {
    threw = true;
  }
  if (!threw) throw new Error("expected parseElx to throw on non-<elx> root");
});

g.test("parseElx: rejects malformed XML", () => {
  let threw = false;
  try {
    parseElx("<elx><engine type='flow'></elx>");
  } catch (_e) {
    threw = true;
  }
  if (!threw) throw new Error("expected parseElx to throw on malformed XML");
});
