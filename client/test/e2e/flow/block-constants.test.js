// @ts-check
// Copied from wireon-process-editor tests/block-constants.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 18.2 — input Constant round-trip.
//
// The Block Settings dialog edits `node._irConstants` (the exporter's
// source of truth). These tests prove that an added/removed constant
// survives export -> serialize -> parse, which is the DoD's round-trip.

import { parseElx } from "/flow/elx/parse.js";
import { serializeElx } from "/flow/elx/serialize.js";
import { parsePlugin } from "/flow/plugins/parse.js";
import { registerPlugin, getBlock, clear } from "/flow/plugins/registry.js";
import { registerPlugin as registerPluginInGraph } from "/flow/graph/register.js";
import { importFlow } from "/flow/graph/import.js";
import { exportFlow } from "/flow/graph/export.js";

const g = /** @type {any} */ (window);
const LG = g.LiteGraph;

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("fetch " + path + " -> " + r.status);
  return await r.text();
}

async function setup() {
  clear();
  for (const id of ["json"]) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

const FIXTURE =
  '<elx>\n' +
  '    <engine type="flow">\n' +
  '        <max_steps>0</max_steps>\n' +
  '        <record_history>false</record_history>\n' +
  '    </engine>\n' +
  '    <node id="template-render" name="Render Template" plugin="json"/>\n' +
  '</elx>\n';

/** @param {any} graph @param {string} name */
function nodeByName(graph, name) {
  return (graph._nodes || []).find((/** @type {any} */ n) => n._irName === name);
}

g.test("constant: a template constant added to _irConstants round-trips to ELX", async () => {
  await setup();
  const { graph } = importFlow(parseElx(FIXTURE), getBlock, LG);
  const node = nodeByName(graph, "Render Template");
  if (!node) throw new Error("node not imported");

  // No constants to start with.
  g.assertEq(exportFlow(graph).nodes[0].constants.length, 0);

  // Mirror what the dialog's setConstant() does for the "template" input.
  node._irConstants = [
    { port: "template", value: { structure: "droplet", value: { id: "string", data: "hello world" } } },
  ];

  const out = serializeElx(exportFlow(graph));
  if (!out.includes('<constant port="template">')) throw new Error("constant element missing:\n" + out);
  if (!out.includes('<value id="string">hello world</value>')) throw new Error("constant value missing:\n" + out);

  // Idempotent re-serialize, and the constant survives a parse cycle.
  const reparsed = parseElx(out);
  g.assertEq(serializeElx(reparsed), out, "idempotent");
  const c = reparsed.nodes[0].constants.find((/** @type {any} */ x) => x.port === "template");
  g.assertEq(c && c.value && c.value.value && c.value.value.data, "hello world");
});

g.test("constant: removing an entry from _irConstants drops it from ELX", async () => {
  await setup();
  const { graph } = importFlow(parseElx(FIXTURE), getBlock, LG);
  const node = nodeByName(graph, "Render Template");
  node._irConstants = [
    { port: "template", value: { structure: "droplet", value: { id: "string", data: "x" } } },
  ];
  let out = serializeElx(exportFlow(graph));
  if (!out.includes('port="template"')) throw new Error("precondition: constant should be present");

  // Dialog unchecks the box -> entry removed.
  node._irConstants = [];
  out = serializeElx(exportFlow(graph));
  if (out.includes('port="template"')) throw new Error("constant should be gone:\n" + out);
});
