// @ts-check
// Copied from wireon-process-editor src/elx/nets.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Net classification helpers.
 *
 * ELX nets are an N-way connection bundle: one source port and one or
 * more sink ports, all referenced by `(nodeName, portName)`. Litegraph
 * links are pairwise (origin -> target). To convert, we have to
 * decide which connection in a net is the source.
 *
 * Classification works by looking up the referenced port on whatever
 * node it lives on:
 *   - PseudoNode kind="input"  -> "port" is an outgoing slot (source side)
 *   - PseudoNode kind="output" -> "port" is an incoming slot (sink side)
 *   - SubflowInstance          -> outer slots mirror body.inputs (sink-side
 *                                 from the outer view) and body.outputs
 *                                 (source-side from the outer view).
 *   - NodeInstance             -> consult BlockDef.inputs / .outputs.
 *
 * ELX port_group ports appear as `name [N]`; strip the `[N]` suffix
 * before comparing against the BlockDef.
 */

/** @typedef {import("./ir.js").Flow} Flow */
/** @typedef {import("./ir.js").Net} Net */
/** @typedef {import("./ir.js").NetConnection} NetConnection */
/** @typedef {import("./ir.js").NodeInstance} NodeInstance */
/** @typedef {import("./ir.js").SubflowInstance} SubflowInstance */
/** @typedef {import("./ir.js").PseudoNode} PseudoNode */
/** @typedef {import("../plugins/parse.js").BlockDef} BlockDef */

/**
 * Result of classifying one ELX net.
 *
 * `source` is `null` if the net is malformed (zero sources, or more
 * than one) — see ARCHITECTURE.md "render it as floating in the UI
 * with a warning".
 *
 * @typedef {Object} ClassifiedNet
 * @property {string} name
 * @property {NetConnection|null} source
 * @property {NetConnection[]} sinks
 * @property {string[]} warnings
 */

/**
 * @callback GetBlock
 * @param {string} plugin
 * @param {string} id
 * @returns {BlockDef|null}
 */

/**
 * Classify every net in a single flow scope. Does NOT recurse into
 * subflow bodies — the caller does that per scope when building the
 * litegraph subgraphs.
 *
 * @param {Flow} flow
 * @param {GetBlock} getBlock
 * @returns {ClassifiedNet[]}
 */
export function classifyNets(flow, getBlock) {
  const idx = buildScopeIndex(flow);
  return flow.nets.map((net) => classifyOne(net, idx, getBlock));
}

/**
 * @param {Net} net
 * @param {ScopeIndex} idx
 * @param {GetBlock} getBlock
 * @returns {ClassifiedNet}
 */
function classifyOne(net, idx, getBlock) {
  /** @type {NetConnection[]} */
  const sources = [];
  /** @type {NetConnection[]} */
  const sinks = [];
  /** @type {string[]} */
  const warnings = [];

  for (const c of net.connections) {
    const dir = directionOf(c, idx, getBlock);
    if (dir === "out") sources.push(c);
    else if (dir === "in") sinks.push(c);
    else {
      // Unknown port → default to sink so it still renders something
      // and emit a warning.
      sinks.push(c);
      warnings.push(`unknown port ${c.node}.${c.port}`);
    }
  }

  if (sources.length === 0) {
    warnings.push("no source connection");
    return { name: net.name, source: null, sinks, warnings };
  }
  if (sources.length > 1) {
    warnings.push(`${sources.length} source connections (expected 1)`);
  }
  return { name: net.name, source: sources[0], sinks, warnings };
}

/**
 * Decide whether a NetConnection refers to an outgoing ("out") or
 * incoming ("in") slot on its node. Returns null if undecidable
 * (e.g. unknown block or port name not found).
 *
 * @param {NetConnection} c
 * @param {ScopeIndex} idx
 * @param {GetBlock} getBlock
 * @returns {"in"|"out"|null}
 */
export function directionOf(c, idx, getBlock) {
  const pseudo = idx.pseudo.get(c.node);
  if (pseudo) {
    // Pseudo-input publishes its value as an OUT-bound slot. Pseudo-output
    // consumes via an IN-bound slot. Either way the port name on the
    // wire is "port" — but tolerate anything else just in case.
    return pseudo.kind === "input" ? "out" : "in";
  }

  const sub = idx.subflows.get(c.node);
  if (sub) {
    // Outer subflow slots mirror the body's pseudo-nodes by name.
    if (sub.body.inputs.some((p) => p.name === c.port)) return "in";
    if (sub.body.outputs.some((p) => p.name === c.port)) return "out";
    return null;
  }

  const node = idx.nodes.get(c.node);
  if (node) {
    const block = getBlock(node.plugin, node.id);
    if (!block) return null;
    const base = basePortName(c.port);
    if (block.inputs.some((p) => p.name === base)) return "in";
    if (block.outputs.some((p) => p.name === base)) return "out";
    return null;
  }

  return null;
}

/**
 * "in [3]" → "in"; "json" → "json". port_group instances expand a
 * single declared port into multiple bracket-indexed instances on the
 * wire.
 *
 * @param {string} portName
 */
export function basePortName(portName) {
  const m = /^(.*?)\s*\[\d+\]\s*$/.exec(portName);
  return m ? m[1] : portName;
}

/**
 * @typedef {Object} ScopeIndex
 * @property {Map<string, PseudoNode>} pseudo
 * @property {Map<string, NodeInstance>} nodes
 * @property {Map<string, SubflowInstance>} subflows
 */

/**
 * Index a flow scope by node name so directionOf is O(1) per lookup.
 *
 * @param {Flow} flow
 * @returns {ScopeIndex}
 */
export function buildScopeIndex(flow) {
  /** @type {ScopeIndex} */
  const idx = { pseudo: new Map(), nodes: new Map(), subflows: new Map() };
  for (const p of flow.inputs) idx.pseudo.set(p.name, p);
  for (const p of flow.outputs) idx.pseudo.set(p.name, p);
  for (const n of flow.nodes) idx.nodes.set(n.name, n);
  for (const s of flow.subflows) idx.subflows.set(s.name, s);
  return idx;
}
