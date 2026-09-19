// @ts-check
// Copied from wireon-process-editor src/graph/export.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * litegraph LGraph -> Flow IR (Phase 10).
 *
 * The inverse of `import.js`. Stashed `_ir*` properties on each node
 * are the authoritative source for fields that don't live on the
 * litegraph object (the original parameter/constant arrays, extras,
 * subflow kind, engine config, …). Anything the user might have
 * *changed* on the canvas — widget values, port_group sizes, link
 * topology — is read live from the LGraph instead.
 *
 * Net reconstruction:
 *   - Group every link by (sourceNode, sourceSlotName).
 *   - For each group, look up the original net name in
 *     `graph._irLinkToNet`. If multiple links share a name (a fan-out
 *     net) we keep using it; otherwise we mint a fresh `N\d+` name.
 *   - Emit `<net>` with the single source connection, then each sink.
 *   - Source order matches `graph._irNetOrder` first, then newly-
 *     generated nets in source-port traversal order.
 */

/** @typedef {import("../elx/ir.js").Flow} Flow */
/** @typedef {import("../elx/ir.js").EngineConfig} EngineConfig */
/** @typedef {import("../elx/ir.js").PseudoNode} PseudoNode */
/** @typedef {import("../elx/ir.js").NodeInstance} NodeInstance */
/** @typedef {import("../elx/ir.js").SubflowInstance} SubflowInstance */
/** @typedef {import("../elx/ir.js").Net} Net */
/** @typedef {import("../elx/ir.js").NetConnection} NetConnection */
/** @typedef {import("../elx/ir.js").ParameterOverride} ParameterOverride */
/** @typedef {import("../elx/ir.js").PortConstant} PortConstant */
/** @typedef {import("../elx/ir.js").PortGroup} PortGroup */

/**
 * @param {any} graph
 * @returns {Flow}
 */
export function exportFlow(graph) {
  /** @type {PseudoNode[]} */
  const inputs = [];
  /** @type {PseudoNode[]} */
  const outputs = [];
  /** @type {NodeInstance[]} */
  const nodes = [];
  /** @type {SubflowInstance[]} */
  const subflows = [];

  const liveNodes = (graph && graph._nodes) || [];
  for (const ln of liveNodes) {
    switch (ln._irKind) {
      case "pseudo-input":
        inputs.push(exportPseudo(ln, "input"));
        break;
      case "pseudo-output":
        outputs.push(exportPseudo(ln, "output"));
        break;
      case "subflow":
        subflows.push(exportSubflow(ln));
        break;
      case "node":
      default:
        nodes.push(exportNode(ln));
        break;
    }
  }

  const nets = exportNets(graph, liveNodes);

  return {
    engine: graph._irEngine || defaultEngine(),
    inputs,
    outputs,
    nodes,
    subflows,
    nets,
  };
}

/**
 * @returns {EngineConfig}
 */
function defaultEngine() {
  return { type: "flow", maxSteps: 0, recordHistory: false };
}

/**
 * @param {any} node
 * @param {"input"|"output"} kind
 * @returns {PseudoNode}
 */
function exportPseudo(node, kind) {
  /** @type {PseudoNode} */
  const out = { kind, name: node._irName || node.title || "" };
  if (node._irStructure) out.structure = node._irStructure;
  return out;
}

/**
 * @param {any} node
 * @returns {NodeInstance}
 */
function exportNode(node) {
  /** @type {NodeInstance} */
  const out = {
    id: node._irNodeId || "",
    plugin: node._irPlugin || "",
    name: node._irName || node.title || "",
    parameters: exportParameters(node),
    constants: node._irConstants ? node._irConstants.slice() : [],
    portGroups: exportPortGroups(node),
  };
  if (node._irExtras) out.extras = node._irExtras;
  return out;
}

/**
 * Walk the original `_irParameters` list and refresh each value from
 * `node.properties` if the property exists. Parameters with no
 * matching property (no widget) are emitted unchanged.
 *
 * @param {any} node
 * @returns {ParameterOverride[]}
 */
function exportParameters(node) {
  const original = node._irParameters || [];
  /** @type {ParameterOverride[]} */
  const out = [];
  for (const p of original) {
    const live = node.properties && Object.prototype.hasOwnProperty.call(node.properties, p.id)
      ? node.properties[p.id]
      : undefined;
    if (live === undefined) {
      out.push(p);
      continue;
    }
    // Reuse the original literal shape (id, plugin, cdata flag), only
    // refresh `data`. That keeps the round-trip byte-identical for
    // unchanged params.
    const refreshed = {
      ...p,
      value: { ...p.value, data: stringifyLiteral(live, p.value && p.value.id) },
    };
    out.push(refreshed);
  }
  return out;
}

/**
 * Match the literal-id formatting used by the importer's `coerceLiteral`.
 *
 * @param {any} v
 * @param {string} [id]
 * @returns {string}
 */
function stringifyLiteral(v, id) {
  if (id === "boolean") return v ? "true" : "false";
  if (id === "integer") {
    const n = Number(v);
    return Number.isFinite(n) ? String(n | 0) : "0";
  }
  if (v == null) return "";
  return String(v);
}

/**
 * Emit one `<port_group>` per current group state on the node. Skips
 * declared-but-empty groups (size 0) — those have no `<port_group>` in
 * source.
 *
 * @param {any} node
 * @returns {PortGroup[]}
 */
function exportPortGroups(node) {
  /** @type {PortGroup[]} */
  const out = [];
  for (const g of node._portGroups || []) {
    if (!g || g.size <= 0) continue;
    out.push({ id: g.id, size: g.size });
  }
  return out;
}

/**
 * @param {any} node
 * @returns {SubflowInstance}
 */
function exportSubflow(node) {
  // The inner subgraph carries the live nested Flow. Recurse into it
  // so edits inside a subflow are reflected on save.
  const body = node.subgraph ? exportFlow(node.subgraph) : (node._irSubflowBody || emptyFlow());

  /** @type {SubflowInstance} */
  const out = {
    kind: node._irSubflowKind || "filter",
    id: node._irSubflowId || "",
    name: node._irName || node.title || "",
    type: node._irSubflowType || "",
    body,
  };
  if (node._irSubflowPlugin !== undefined) out.plugin = node._irSubflowPlugin;
  return out;
}

/**
 * @returns {Flow}
 */
function emptyFlow() {
  return {
    engine: defaultEngine(),
    inputs: [], outputs: [], nodes: [], subflows: [], nets: [],
  };
}

/**
 * Reconstruct ELX nets from the live LGraph.
 *
 * Strategy:
 *   1. Group every live link by `(source node, source slot)`. Each
 *      group corresponds to one ELX net.
 *   2. For each group, pick a name: reuse the original net name when
 *      all of the group's links share it, otherwise mint a fresh
 *      `N\d+`.
 *   3. Emit nets in original source order. When the live group still
 *      matches its original net 1:1 (same set of `(node, port)`
 *      endpoints), reuse the original connection ordering verbatim
 *      — this preserves quirks like "sink listed before source".
 *      Anything new or modified emits source-first.
 *
 * @param {any} graph
 * @param {any[]} liveNodes
 * @returns {Net[]}
 */
function exportNets(graph, liveNodes) {
  /** @type {Map<number, any>} */
  const byId = new Map();
  for (const n of liveNodes) byId.set(n.id, n);
  /** @type {Map<number, string>} */
  const linkToNet = graph._irLinkToNet || new Map();
  /** @type {Net[]} */
  const originalNets = graph._irNets || [];
  const originalByName = new Map(originalNets.map((n) => [n.name, n]));

  const allLinks = graph.links || {};
  const linkIds = Object.keys(allLinks).map((k) => Number(k)).sort((a, b) => a - b);

  /** @type {Map<string, { srcNode: any, srcSlot: number, linkIds: number[] }>} */
  const groups = new Map();
  for (const lid of linkIds) {
    const link = allLinks[lid];
    if (!link) continue;
    const srcNode = byId.get(link.origin_id);
    if (!srcNode) continue;
    const k = `${link.origin_id}:${link.origin_slot}`;
    let g = groups.get(k);
    if (!g) {
      g = { srcNode, srcSlot: link.origin_slot, linkIds: [] };
      groups.set(k, g);
    }
    g.linkIds.push(lid);
  }

  const used = new Set();
  /** @type {Map<string, { name: string, group: any }>} */
  const decided = new Map();
  let nextN = 1;
  for (const [key, group] of groups) {
    /** @type {string|null} */
    let name = null;
    for (const lid of group.linkIds) {
      const nm = linkToNet.get(lid);
      if (nm && (name === null || nm === name)) name = nm;
      else if (nm && nm !== name) { name = null; break; }
    }
    if (!name || used.has(name)) {
      while (used.has(`N${pad3(nextN)}`)) nextN++;
      name = `N${pad3(nextN)}`;
      nextN++;
    }
    used.add(name);
    decided.set(key, { name, group });
  }

  // Emit nets in original order first, then any new nets.
  /** @type {Net[]} */
  const nets = [];
  const emitted = new Set();
  const decidedByName = new Map();
  for (const d of decided.values()) decidedByName.set(d.name, d);

  for (const orig of originalNets) {
    const d = decidedByName.get(orig.name);
    if (!d || emitted.has(d.name)) continue;
    nets.push(buildNet(d.name, d.group, originalByName.get(d.name)));
    emitted.add(d.name);
  }
  for (const d of decided.values()) {
    if (emitted.has(d.name)) continue;
    nets.push(buildNet(d.name, d.group, originalByName.get(d.name)));
    emitted.add(d.name);
  }
  return nets;
}

/**
 * Build the connections array for one net. If the live endpoints
 * exactly match the original net's connections (set equality), reuse
 * the original ordering verbatim — preserving any source/sink
 * authoring quirks. Otherwise emit source-first, sinks in link-id
 * order.
 *
 * @param {string} name
 * @param {{ srcNode: any, srcSlot: number, linkIds: number[] }} group
 * @param {Net | undefined} original
 * @returns {Net}
 */
function buildNet(name, group, original) {
  const graph = group.srcNode.graph;
  const allLinks = (graph && graph.links) || {};
  const srcSlotName = (group.srcNode.outputs && group.srcNode.outputs[group.srcSlot] && group.srcNode.outputs[group.srcSlot].name) || "";
  const srcName = group.srcNode._irName || group.srcNode.title || "";

  /** @type {NetConnection[]} */
  const sinks = [];
  for (const lid of group.linkIds) {
    const link = allLinks[lid];
    if (!link) continue;
    const tgt = graph._nodes && graph._nodes.find((/** @type {any} */ n) => n.id === link.target_id);
    if (!tgt) continue;
    const tgtSlot = tgt.inputs && tgt.inputs[link.target_slot];
    sinks.push({
      node: tgt._irName || tgt.title || "",
      port: (tgtSlot && tgtSlot.name) || "",
    });
  }

  // If the live endpoints match the original net's connections, reuse
  // the original ordering.
  if (original) {
    const wantedSrc = `${srcName} ${srcSlotName}`;
    const live = new Set();
    live.add(wantedSrc);
    for (const s of sinks) live.add(`${s.node} ${s.port}`);
    const original_keys = original.connections.map((c) => `${c.node} ${c.port}`);
    const wantedSet = new Set(original_keys);
    if (live.size === wantedSet.size && original_keys.every((k) => live.has(k))) {
      return { name, connections: original.connections.map((c) => ({ node: c.node, port: c.port })) };
    }
  }

  /** @type {NetConnection[]} */
  const connections = [{ node: srcName, port: srcSlotName }];
  for (const s of sinks) connections.push(s);
  return { name, connections };
}

/**
 * @param {number} n
 */
function pad3(n) {
  return String(n).padStart(3, "0");
}
