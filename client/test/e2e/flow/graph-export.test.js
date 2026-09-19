// @ts-check
// Copied from wireon-process-editor tests/graph-export.test.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the modules are imported from /flow/ (this repository's copy of them) and
// the fixtures from /flow/palette and /flow/samples. The assertions are
// untouched — that is the point of running them here.
// Phase 10 — exportFlow round-trip. The critical test in the repo.
//
// For every sample: parse -> importFlow -> exportFlow should yield an
// IR structurally identical to the parsed one, and re-serializing
// should produce the same XML.

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

const PLUGINS = [
  "builtin", "filesystem", "http", "json", "mathematics",
  "opencv", "strings",
];

async function setupRegistry() {
  clear();
  for (const id of PLUGINS) {
    const def = parsePlugin(await fetchText(`/flow/palette/plugins/${id}/plugin.xml`));
    registerPlugin(def);
    registerPluginInGraph(def, LG);
  }
}

g.test("exportFlow: file-response round-trips byte-identical", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/file-response.elx");
  const flow1 = parseElx(src);
  const { graph } = importFlow(flow1, getBlock, LG);
  const flow2 = exportFlow(graph);
  const out = serializeElx(flow2);
  // Idempotence: re-parse and re-serialize should be identical to `out`.
  const flow3 = parseElx(out);
  const out2 = serializeElx(flow3);
  g.assertEq(out, out2, "idempotent");
  // IR equality after a parse-serialize-parse cycle.
  assertIREq(flow1, flow3, "file-response.elx");
});

g.test("exportFlow: create-albumlist round-trips byte-identical (full sample)", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const flow1 = parseElx(src);
  const { graph } = importFlow(flow1, getBlock, LG);
  const flow2 = exportFlow(graph);
  const out = serializeElx(flow2);
  const out2 = serializeElx(parseElx(out));
  g.assertEq(out, out2, "idempotent");
  assertIREq(flow1, parseElx(out), "create-albumlist.elx");
});

g.test("exportFlow: structural identity (deep equality) on create-albumlist", async () => {
  await setupRegistry();
  const src = await fetchText("/flow/samples/create-albumlist.elx");
  const flow1 = parseElx(src);
  const { graph } = importFlow(flow1, getBlock, LG);
  const flow2 = exportFlow(graph);
  assertIREq(flow1, flow2, "exported IR vs parsed IR");
});

/**
 * @param {any} a
 * @param {any} b
 * @param {string} label
 */
function assertIREq(a, b, label) {
  if (!deepEq(a, b)) {
    const path = firstDiffPath(a, b);
    throw new Error(label + ": IR differs at " + path);
  }
}

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEq(a[k], b[k])) return false;
  return true;
}

/** Best-effort diff locator for failure messages. */
function firstDiffPath(a, b, prefix = "") {
  if (Object.is(a, b)) return "(equal)";
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${prefix}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${prefix}: array vs object mismatch`;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return `${prefix}: key count ${ak.length} vs ${bk.length}`;
  for (const k of ak) {
    if (!deepEq(a[k], b[k])) {
      return firstDiffPath(a[k], b[k], prefix + "/" + k);
    }
  }
  return `${prefix}: unknown`;
}
