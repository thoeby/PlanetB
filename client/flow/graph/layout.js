// @ts-check
// Copied from wireon-process-editor src/graph/layout.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: LAYER_WIDTH 220 -> 300, because design 10a draws blocks up to 260 wide
/**
 * Layered auto-layout for one flow scope.
 *
 * Algorithm (per ARCHITECTURE.md):
 *   1. Build a DAG of node-name -> predecessor names using the
 *      net source/sink classification.
 *   2. Assign each node a "layer" = longest path from a source. Nodes
 *      with no incoming edges sit at layer 0; pseudo-inputs always do.
 *   3. Within a layer, sort by the mean layer-position of predecessors
 *      to reduce edge crossings (a one-pass barycentric heuristic).
 *   4. Place at x = layer * 220, y = position-in-layer * 80.
 *
 * The result is a `Map<nodeName, {x, y}>`. Callers overlay user-saved
 * coordinates from the layout sidecar on top of this.
 */

import { classifyNets, buildScopeIndex } from "../elx/nets.js";

/** @typedef {import("../elx/ir.js").Flow} Flow */
/** @typedef {import("../elx/nets.js").GetBlock} GetBlock */

const LAYER_WIDTH = 300;
const ROW_HEIGHT = 80;
const TOP_PAD = 40;
const LEFT_PAD = 40;

/**
 * @param {Flow} flow
 * @param {GetBlock} getBlock
 * @returns {Map<string, { x: number, y: number }>}
 */
export function layout(flow, getBlock) {
  buildScopeIndex(flow); // validates names but otherwise unused at this scope.
  /** @type {string[]} */
  const allNames = [
    ...flow.inputs.map((p) => p.name),
    ...flow.nodes.map((n) => n.name),
    ...flow.subflows.map((s) => s.name),
    ...flow.outputs.map((p) => p.name),
  ];

  // Adjacency: succ[a] contains b iff a net is wired from a's output
  // to b's input. We only need `pred` for layering but keep `succ` for
  // future use (e.g. crossings minimisation).
  /** @type {Map<string, Set<string>>} */
  const succ = new Map();
  /** @type {Map<string, Set<string>>} */
  const pred = new Map();
  for (const n of allNames) {
    succ.set(n, new Set());
    pred.set(n, new Set());
  }

  const classified = classifyNets(flow, getBlock);
  for (const net of classified) {
    if (!net.source) continue;
    const src = net.source.node;
    for (const sink of net.sinks) {
      if (sink.node === src) continue;
      const sset = succ.get(src);
      const pset = pred.get(sink.node);
      if (!sset || !pset) continue;
      sset.add(sink.node);
      pset.add(src);
    }
  }

  // Pseudo-inputs are always layer-0 sources.
  /** @type {Map<string, number>} */
  const layerOf = new Map();
  for (const p of flow.inputs) layerOf.set(p.name, 0);

  // Iterative longest-path: layer(v) = 1 + max(layer(pred(v))).
  // Small graphs (n < ~50); a few passes converge.
  let changed = true;
  let guard = allNames.length + 5;
  while (changed && guard-- > 0) {
    changed = false;
    for (const name of allNames) {
      const ps = /** @type {Set<string>} */ (pred.get(name));
      let best = layerOf.get(name);
      if (best === undefined) best = 0;
      if (ps.size > 0) {
        let m = -1;
        let allSeen = true;
        for (const p of ps) {
          const lp = layerOf.get(p);
          if (lp === undefined) { allSeen = false; break; }
          if (lp > m) m = lp;
        }
        if (allSeen) best = Math.max(best, m + 1);
      }
      if (layerOf.get(name) !== best) {
        layerOf.set(name, best);
        changed = true;
      }
    }
  }

  // Note: pseudo-outputs already pick up their natural layer from the
  // iterative pass above (predecessors include whatever feeds them).
  // We deliberately do NOT force them past the rightmost real layer —
  // doing so leaves a visible empty column on flows where outputs are
  // wired only one hop from inputs.

  // Bucket by layer.
  /** @type {Map<number, string[]>} */
  const byLayer = new Map();
  for (const name of allNames) {
    const l = layerOf.get(name) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    /** @type {string[]} */ (byLayer.get(l)).push(name);
  }

  // Barycentric pass: order each layer by mean row of its predecessors
  // in already-placed layers.
  /** @type {Map<string, number>} */
  const rowOf = new Map();
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  for (let li = 0; li < layers.length; li++) {
    const l = layers[li];
    const names = /** @type {string[]} */ (byLayer.get(l));
    if (li === 0) {
      names.forEach((n, i) => rowOf.set(n, i));
      continue;
    }
    const annotated = names.map((n, srcIdx) => {
      const ps = /** @type {Set<string>} */ (pred.get(n));
      let sum = 0, count = 0;
      for (const p of ps) {
        const r = rowOf.get(p);
        if (r !== undefined) { sum += r; count++; }
      }
      return {
        name: n,
        srcIdx,
        key: count > 0 ? sum / count : Number.POSITIVE_INFINITY,
      };
    });
    // Sort by mean predecessor row; stable on source order via srcIdx.
    annotated.sort((a, b) => a.key - b.key || a.srcIdx - b.srcIdx);
    annotated.forEach((a, i) => rowOf.set(a.name, i));
  }

  /** @type {Map<string, { x: number, y: number }>} */
  const out = new Map();
  for (const name of allNames) {
    const l = layerOf.get(name) ?? 0;
    const r = rowOf.get(name) ?? 0;
    out.set(name, {
      x: LEFT_PAD + l * LAYER_WIDTH,
      y: TOP_PAD + r * ROW_HEIGHT,
    });
  }
  return out;
}
