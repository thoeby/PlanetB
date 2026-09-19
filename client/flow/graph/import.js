// @ts-check
// Copied from wireon-process-editor src/graph/import.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the layout overrides come from ./layoutstore.js (flow.layout in the world)
// rather than ../layout-store/sidecar.js (localStorage), and saveNodePosition,
// which that import listed but never used, is no longer imported.
/**
 * Flow IR -> litegraph LGraph.
 *
 * For each scope we create one litegraph node per IR entity (pseudo-
 * inputs, NodeInstances, SubflowInstances, pseudo-outputs), then walk
 * the classified nets to emit pairwise links. Litegraph's `add()`
 * assigns numeric ids; we keep a name -> node map for connection
 * lookup and stash `node._irName` on every created node so the
 * exporter (Phase 10) can recover it.
 *
 * Subflow bodies are populated by recursing into `subflow.body` —
 * `createSubflowNode` (in `subflow.js`) creates an inner LGraph and
 * calls back into `importFlow` to fill it.
 *
 * Auto-layout positions are applied straight onto `node.pos`; saved
 * overrides from the layout sidecar (Phase 9) take precedence.
 */

import { classifyNets, basePortName } from "../elx/nets.js";
import { layout as autoLayout } from "./layout.js";
import { flowHash as computeFlowHash, loadOverrides, loadHiddenOutputs } from "./layoutstore.js";
import { applyHiddenOutputFlags } from "./hideoutputs.js";
import { typeName as blockTypeName } from "./register.js";
import { createSubflowNode as buildSubflowNode } from "./subflow.js";
import {
  attachPortGroupControls,
  defaultGroupsFor,
  slotTypeFromPort,
} from "./portgroup.js";

/** @typedef {import("../elx/ir.js").Flow} Flow */
/** @typedef {import("../elx/ir.js").NodeInstance} NodeInstance */
/** @typedef {import("../elx/ir.js").PseudoNode} PseudoNode */
/** @typedef {import("../elx/nets.js").GetBlock} GetBlock */

const PSEUDO_INPUT_TYPE = "wireon/flow-input";
const PSEUDO_OUTPUT_TYPE = "wireon/flow-output";

let pseudoTypesRegistered = false;

/**
 * Result of importing a flow. Carries the graph plus the per-link net
 * names so Phase 10 can reconstruct ELX nets.
 *
 * @typedef {Object} ImportResult
 * @property {any} graph                Populated LGraph.
 * @property {Map<number, string>} linkToNet
 * @property {string[]} warnings
 */

/**
 * @param {Flow} flow
 * @param {GetBlock} getBlock
 * @param {any} LiteGraph
 * @param {any} [graph]                 Pre-existing LGraph to fill in; created if absent.
 * @param {string} [scopePath]          Empty for top-level; used by layout sidecar.
 * @param {string} [flowHash]           Stable hash for the sidecar key; "" disables overrides.
 * @returns {ImportResult}
 */
export function importFlow(flow, getBlock, LiteGraph, graph, scopePath = "", flowHash = "") {
  ensurePseudoTypes(LiteGraph);
  const g = graph || new LiteGraph.LGraph();
  // Auto-compute a hash for the top-level scope so callers can omit it
  // and still get layout persistence. Subflow recursion passes through
  // the parent's hash unchanged.
  const effectiveHash = flowHash || (scopePath === "" ? computeFlowHash(flow) : "");

  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, any>} */
  const byName = new Map();

  for (const p of flow.inputs) byName.set(p.name, createPseudo(p, LiteGraph));
  for (const p of flow.outputs) byName.set(p.name, createPseudo(p, LiteGraph));
  for (const n of flow.nodes) byName.set(n.name, createBlockNode(n, getBlock, LiteGraph, warnings));
  for (const s of flow.subflows) {
    byName.set(
      s.name,
      buildSubflowNode(s, getBlock, LiteGraph, importFlow, scopePath, effectiveHash),
    );
  }

  // Stash engine config and net-name table on the graph so the exporter
  // (Phase 10) can re-emit them verbatim. linkToNet is filled below
  // after links are created; the reference is the same Map.
  /** @type {Map<number, string>} */
  const linkToNet = new Map();
  g._irEngine = flow.engine;
  g._irLinkToNet = linkToNet;
  // Preserve the originals so the exporter can re-emit each net's
  // connections in source order — including any quirks like "sink
  // listed before source" that ELX permits.
  g._irNets = flow.nets;

  // Add to graph first so connect() can run (link IDs require graph).
  for (const node of byName.values()) g.add(node);

  // Position: auto-layout, then overlay sidecar overrides.
  const pos = autoLayout(flow, getBlock);
  const overrides = effectiveHash ? loadOverrides(effectiveHash, scopePath) : new Map();
  const hidden = effectiveHash ? loadHiddenOutputs(effectiveHash, scopePath) : new Map();
  for (const [name, node] of byName) {
    const o = overrides.get(name);
    const p = o || pos.get(name);
    if (p) node.pos = [p.x, p.y];
    // Stamp the sidecar coordinates so the drag handler can read them back.
    node._irScopePath = scopePath;
    node._irFlowHash = effectiveHash;
    // Stamp hidden-output state (Phase 18.3) so the renderer and the
    // Block Settings dialog can read it back.
    node._hiddenOutputs = hidden.get(name) || new Set();
  }

  // Apply parameter overrides and constants. Both rely on the node
  // already existing (widgets are wired in the ctor).
  for (const n of flow.nodes) applyOverrides(n, byName.get(n.name), warnings);

  // Wire links.
  const classified = classifyNets(flow, getBlock);
  for (const net of classified) {
    for (const w of net.warnings) warnings.push(`net ${net.name}: ${w}`);
    if (!net.source) continue;
    const srcNode = byName.get(net.source.node);
    if (!srcNode) {
      warnings.push(`net ${net.name}: missing source node ${net.source.node}`);
      continue;
    }
    const outIdx = findSlotIndex(srcNode.outputs, net.source.port);
    if (outIdx < 0) {
      warnings.push(`net ${net.name}: ${net.source.node} has no output ${net.source.port}`);
      continue;
    }
    for (const sink of net.sinks) {
      const sinkNode = byName.get(sink.node);
      if (!sinkNode) {
        warnings.push(`net ${net.name}: missing sink node ${sink.node}`);
        continue;
      }
      const inIdx = findSlotIndex(sinkNode.inputs, sink.port);
      if (inIdx < 0) {
        warnings.push(`net ${net.name}: ${sink.node} has no input ${sink.port}`);
        continue;
      }
      const link = srcNode.connect(outIdx, sinkNode, inIdx);
      if (link && typeof link.id === "number") linkToNet.set(link.id, net.name);
    }
  }

  // Seed link visibility from the hidden-output sets now that links exist.
  applyHiddenOutputFlags(g);

  return { graph: g, linkToNet, warnings };
}

/**
 * Locate a slot by name. Falls back to the bracket-stripped base name
 * so `port_group` ports like "in [2]" still match an "in" slot if the
 * subflow contract didn't pre-expand them.
 *
 * @param {Array<{name: string}>} slots
 * @param {string} portName
 */
function findSlotIndex(slots, portName) {
  if (!slots) return -1;
  for (let i = 0; i < slots.length; i++) if (slots[i].name === portName) return i;
  const base = basePortName(portName);
  if (base !== portName) {
    for (let i = 0; i < slots.length; i++) if (slots[i].name === base) return i;
  }
  return -1;
}

/**
 * @param {PseudoNode} p
 * @param {any} LiteGraph
 */
function createPseudo(p, LiteGraph) {
  const type = p.kind === "input" ? PSEUDO_INPUT_TYPE : PSEUDO_OUTPUT_TYPE;
  const node = LiteGraph.createNode(type);
  node.title = p.name;
  node._irName = p.name;
  node._irKind = p.kind === "input" ? "pseudo-input" : "pseudo-output";
  if (p.structure) node._irStructure = p.structure;
  return node;
}

/**
 * @param {NodeInstance} n
 * @param {GetBlock} getBlock
 * @param {any} LiteGraph
 * @param {string[]} warnings
 */
function createBlockNode(n, getBlock, LiteGraph, warnings) {
  const block = getBlock(n.plugin, n.id);
  let node;
  if (block) {
    node = LiteGraph.createNode(blockTypeName(block));
    if (!node) {
      warnings.push(`createNode failed for ${n.plugin}/${n.id} (registered but not creatable)`);
      node = createPlaceholderNode(n, LiteGraph);
    }
  } else {
    warnings.push(`unknown block ${n.plugin}/${n.id} — using placeholder`);
    node = createPlaceholderNode(n, LiteGraph);
  }
  node.title = n.name;
  node._irName = n.name;
  node._irKind = "node";
  node._irNodeId = n.id;
  node._irPlugin = n.plugin;
  // Preserve the as-parsed parameter and extras data so the exporter
  // can rebuild ELX-faithful nodes (parameters that didn't get a widget,
  // unknown attributes / children). Parameters that did get a widget
  // are recovered from `node.properties` at export time.
  node._irParameters = n.parameters;
  node._irConstants = n.constants;
  if (n.extras) node._irExtras = n.extras;

  // port_group: expand any `<port_group id="X" size="N">` into N bracket-
  // indexed input slots based on the block's declared "X" input.
  /** @type {import("./portgroup.js").PortGroupState[]} */
  const groupStates = [];
  const seen = new Set();
  for (const pg of n.portGroups) {
    const tmpl = block?.inputs.find((p) => p.name === pg.id);
    expandPortGroup(node, pg, block);
    groupStates.push({
      id: pg.id,
      size: pg.size,
      min: tmpl?.min ?? 0,
      slotType: slotTypeFromPort(tmpl),
      template: tmpl,
    });
    seen.add(pg.id);
  }
  // Discover any block-declared repeatable inputs that didn't have a
  // port_group instance (size 0). Stamp them so +/- controls still work
  // for newly-spawned nodes.
  for (const extra of defaultGroupsFor(block)) {
    if (seen.has(extra.id)) continue;
    groupStates.push(extra);
  }
  node._portGroups = groupStates;
  attachPortGroupControls(node);

  return node;
}

/**
 * @param {any} node
 * @param {import("../elx/ir.js").PortGroup} pg
 * @param {import("../plugins/parse.js").BlockDef|null} block
 */
function expandPortGroup(node, pg, block) {
  // Find the existing template slot (declared with type="group" in
  // plugin XML, e.g. Append.in or OR.in).
  const template = block?.inputs.find((p) => p.name === pg.id);
  // Determine the litegraph slot type from the template if any.
  const type = template
    ? slotTypeFromPort(template)
    : "*";
  // Drop any slots that already represent this group — either the bare
  // template ("in") or pre-expanded bracket-indexed ("in [0]", …) the
  // ctor may have added — so we can re-add exactly `pg.size` of them.
  if (node.inputs) {
    const bracket = new RegExp(`^${escapeRegExp(pg.id)}(\\s*\\[\\d+\\])?$`);
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      if (bracket.test(node.inputs[i].name)) node.inputs.splice(i, 1);
    }
  }
  for (let i = 0; i < pg.size; i++) {
    node.addInput(`${pg.id} [${i}]`, type, template ? { _port: template } : undefined);
  }
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * Fallback node for unknown blocks. Slots are derived later from net
 * references (Phase 6 just leaves them empty so net wiring can attach
 * them on demand). Title is set by the caller.
 *
 * @param {NodeInstance} n
 * @param {any} LiteGraph
 */
function createPlaceholderNode(n, LiteGraph) {
  const node = new LiteGraph.LGraphNode(n.name);
  // _irPlaceholder is the theme's hook to render the diagonal-hatch
  // body. No per-node colors: leave bgcolor/color unset so the theme
  // defaults take effect.
  node._irPlaceholder = true;
  return node;
}

/**
 * Apply <parameter> and <constant> overrides from the IR onto a
 * created litegraph node. Parameters update widgets + properties;
 * constants are stashed on the input slot as `_constant` for the
 * exporter to read back later.
 *
 * @param {NodeInstance} n
 * @param {any} node
 * @param {string[]} warnings
 */
function applyOverrides(n, node, warnings) {
  if (!node) return;
  for (const p of n.parameters) {
    if (!node.properties) node.properties = {};
    node.properties[p.id] = coerceLiteral(p.value);
    const widget = node.widgets?.find((/** @type {any} */ w) =>
      w.options?.property === p.id || w.name === p.id
    );
    if (widget) widget.value = node.properties[p.id];
  }
  for (const c of n.constants) {
    const idx = findSlotIndex(node.inputs, c.port);
    if (idx < 0) {
      // Could be an output-side constant (the empty <constant port="error"/>
      // sentinel). Check outputs too.
      const oidx = findSlotIndex(node.outputs, c.port);
      if (oidx >= 0) node.outputs[oidx]._constant = c.value || null;
      else warnings.push(`${n.name}: constant for unknown port ${c.port}`);
      continue;
    }
    node.inputs[idx]._constant = c.value || null;
  }
}

/**
 * @param {import("../elx/ir.js").ValueLiteral} v
 */
function coerceLiteral(v) {
  if (!v) return null;
  switch (v.id) {
    case "boolean": return v.data === "true";
    case "integer": {
      const n = Number.parseInt(v.data, 10);
      return Number.isFinite(n) ? n : 0;
    }
    default: return v.data ?? "";
  }
}

/**
 * Register the pseudo-input / pseudo-output node types once. Both
 * have a single slot named "port"; titles are set per-instance.
 *
 * @param {any} LiteGraph
 */
function ensurePseudoTypes(LiteGraph) {
  if (pseudoTypesRegistered) return;

  function FlowInput() {
    /** @type {any} */ (this).addOutput("port", "*");
  }
  FlowInput.title = "Flow Input";
  FlowInput.desc = "Top-level <input> pseudo-node.";
  LiteGraph.registerNodeType(PSEUDO_INPUT_TYPE, FlowInput);

  function FlowOutput() {
    /** @type {any} */ (this).addInput("port", "*");
  }
  FlowOutput.title = "Flow Output";
  FlowOutput.desc = "Top-level <output> pseudo-node.";
  LiteGraph.registerNodeType(PSEUDO_OUTPUT_TYPE, FlowOutput);

  pseudoTypesRegistered = true;
}

/**
 * Test-only escape hatch so reloading litegraph between tests starts
 * from a clean slate.
 */
export function _resetPseudoTypeFlag() {
  pseudoTypesRegistered = false;
}
