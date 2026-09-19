// @ts-check
// Copied from wireon-process-editor tests/plugin-parse.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 3 — plugin XML parser tests.
//
// Run in the browser via tests.html. The runner exposes test/assertEq
// as globals.

import { parsePlugin } from "/flow/plugins/parse.js";

const g = /** @type {any} */ (window);

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

// ---------------------------------------------------------------------------
// json plugin — the canonical example for this phase
// ---------------------------------------------------------------------------

g.test("parsePlugin: json — plugin-level metadata", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  g.assertEq(def.id, "json", "plugin id");
  g.assertEq(def.name, "JSON", "plugin display name");
  g.assertEq(def.format, "1", "format attr");
  g.assertEq(def.icon, "file::json", "plugin icon text");
  g.assertEq(def.iconType, "simicons", "plugin icon type");
});

g.test("parsePlugin: json — top-level vs grouped block count", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  // create-empty-object, from-string, from-table, template-render,
  // to-string, get, set
  g.assertEq(def.blocks.length, 7, "top-level block count");
  g.assertEq(def.groups.length, 1, "one top-level group");
  g.assertEq(def.groups[0].id, "array", "group id");
  g.assertEq(def.groups[0].name, "Array", "group display name");
  g.assertEq(def.groups[0].blocks.length, 4, "array group block count");
  g.assertEq(def.groups[0].groups.length, 0, "no nested groups");
});

g.test("parsePlugin: json — block ids preserve XML order", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  g.assertEq(
    def.blocks.map((/** @type {any} */ b) => b.id),
    ["create-empty-object", "from-string", "from-table", "template-render", "to-string", "get", "set"]
  );
  g.assertEq(
    def.groups[0].blocks.map((/** @type {any} */ b) => b.id),
    ["append", "create-empty", "get-element", "size"]
  );
});

g.test("parsePlugin: json — grouped block carries groupPath and plugin id", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  const append = def.groups[0].blocks.find((/** @type {any} */ b) => b.id === "append");
  if (!append) throw new Error("block 'append' not found");
  g.assertEq(append.plugin, "json", "plugin id propagated");
  g.assertEq(append.groupPath, ["array"], "groupPath for nested block");

  const fromString = def.blocks.find((/** @type {any} */ b) => b.id === "from-string");
  g.assertEq(fromString.groupPath, [], "root-level block has empty groupPath");
});

// ---------------------------------------------------------------------------
// json/template-render — spot check of structure
// ---------------------------------------------------------------------------

g.test("parsePlugin: json — template-render display fields", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  const tr = def.blocks.find((/** @type {any} */ b) => b.id === "template-render");
  if (!tr) throw new Error("template-render not found");
  g.assertEq(tr.name, "Render Template", "display name");
  g.assertEq(tr.descriptions.short, "Render a template with specific data");
  g.assertEq(
    tr.descriptions.long,
    "A template renderer loosely inspired by jinja for python."
  );
});

g.test("parsePlugin: json — template-render parameters with defaults", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  const tr = def.blocks.find((/** @type {any} */ b) => b.id === "template-render");
  g.assertEq(tr.parameters.length, 2, "two parameters");

  const trim = tr.parameters[0];
  g.assertEq(trim.id, "trim-blocks");
  g.assertEq(trim.name, "Trim Blocks");
  g.assertEq(trim.default.id, "boolean", "trim-blocks default widget type");
  g.assertEq(trim.default.data, "true", "trim-blocks default value");

  const lstrip = tr.parameters[1];
  g.assertEq(lstrip.id, "left-strip-blocks");
  g.assertEq(lstrip.default.id, "boolean");
  g.assertEq(lstrip.default.data, "false");
});

g.test("parsePlugin: json — template-render ports", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/json/plugin.xml"));
  const tr = def.blocks.find((/** @type {any} */ b) => b.id === "template-render");

  g.assertEq(tr.inputs.length, 2);
  g.assertEq(tr.outputs.length, 2);

  // template input: union value type
  const template = tr.inputs[0];
  g.assertEq(template.name, "template");
  g.assertEq(template.structures.map((/** @type {any} */ s) => s.id), ["droplet"]);
  g.assertEq(
    template.values.map((/** @type {any} */ v) => v.id),
    ["string", "filesystem path"],
    "template accepts string or filesystem path"
  );

  // json input: <constant>false</constant> means "must be wired" (Q2).
  const json = tr.inputs[1];
  g.assertEq(json.name, "json");
  g.assertEq(json.constant, "false", "raw constant text preserved");
  g.assertEq(json.structures[0].id, "droplet");
  g.assertEq(json.values[0].id, "json");

  // error output uses the error-code value id (this is intentional in
  // the source — the value id is a literal "error-code" string).
  const err = tr.outputs[1];
  g.assertEq(err.name, "error");
  g.assertEq(err.values[0].id, "error-code");
});

// ---------------------------------------------------------------------------
// filesystem plugin — covers nested-group, type="group", default values
// ---------------------------------------------------------------------------

g.test("parsePlugin: filesystem — path.append carries type='group' min='2'", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/filesystem/plugin.xml"));
  const path = def.groups.find((/** @type {any} */ gr) => gr.id === "path");
  if (!path) throw new Error("group 'path' not found");
  const append = path.blocks.find((/** @type {any} */ b) => b.id === "append");
  if (!append) throw new Error("block 'append' not found in path group");
  g.assertEq(append.inputs.length, 1);
  const inPort = append.inputs[0];
  g.assertEq(inPort.name, "in");
  g.assertEq(inPort.type, "group", "type attribute preserved");
  g.assertEq(inPort.repeatable, true, "type='group' implies repeatable");
  g.assertEq(inPort.min, 2, "min attribute parsed");
});

g.test("parsePlugin: filesystem — Write.truncate carries a baked-in default", async () => {
  const def = parsePlugin(await fetchText("/flow/palette/plugins/filesystem/plugin.xml"));
  const file = def.groups.find((/** @type {any} */ gr) => gr.id === "file");
  const write = file.blocks.find((/** @type {any} */ b) => b.id === "write");
  if (!write) throw new Error("block 'write' not found");
  const truncate = write.inputs.find((/** @type {any} */ p) => p.name === "truncate");
  if (!truncate) throw new Error("'truncate' input not found");
  // The XML uses <structure id="droplet" default="true"><value …>true</value>.
  g.assertEq(truncate.structures[0].id, "droplet");
  g.assertEq(truncate.structures[0].defaultAttr, "true");
  g.assertEq(truncate.structures[0].value?.id, "boolean");
  g.assertEq(truncate.structures[0].value?.data, "true");
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

g.test("parsePlugin: rejects non-<plugin> root", () => {
  let threw = false;
  try {
    parsePlugin("<not-plugin/>");
  } catch (_e) {
    threw = true;
  }
  if (!threw) throw new Error("expected parsePlugin to throw on non-<plugin> root");
});

g.test("parsePlugin: rejects malformed XML", () => {
  let threw = false;
  try {
    parsePlugin("<plugin id='x'><name>X</plugin>");
  } catch (_e) {
    threw = true;
  }
  if (!threw) throw new Error("expected parsePlugin to throw on malformed XML");
});
