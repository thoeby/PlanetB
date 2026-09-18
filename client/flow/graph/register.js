// @ts-check
// Copied from wireon-process-editor src/graph/register.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Bridge between the plugin registry and litegraph's node-type system.
 *
 * `registerBlock(blockDef, LiteGraph)` creates a litegraph node class
 * whose constructor wires up the slots and widgets declared in the
 * plugin XML, then registers it under
 * `${plugin}/${groupPath.join('/')}/${blockId}`.
 *
 * Slot type strings:
 *   - The litegraph slot `type` is the comma-joined list of value ids
 *     (`"string,filesystem path"`). litegraph's built-in
 *     `LiteGraph.isValidConnection` already does the value-set check,
 *     but that ignores structure. We attach the full port def to the
 *     slot via `_port` so `isValidConnection(out, in)` below can also
 *     enforce structure compatibility (Q3 in OPEN-QUESTIONS).
 *
 * Widgets:
 *   - boolean parameter → "toggle"
 *   - integer parameter → "number"
 *   - everything else  → "text"
 *   Each parameter is mirrored into `this.properties[paramId]`; the
 *   widget callback updates that property so default-value flows
 *   round-trip cleanly when Phase 10 exports.
 */

/** @typedef {import("../plugins/parse.js").BlockDef} BlockDef */
/** @typedef {import("../plugins/parse.js").PortDef} PortDef */
/** @typedef {import("../plugins/parse.js").ParameterDef} ParameterDef */

import { attachPortGroupControls, defaultGroupsFor } from "./portgroup.js";

/**
 * Build the canonical litegraph type-name for a block. Matches what
 * the importer (Phase 6) needs to feed to `LiteGraph.createNode`.
 *
 * @param {BlockDef} block
 */
export function typeName(block) {
  return [block.plugin, ...block.groupPath, block.id].join("/");
}

/**
 * Register a single block as a litegraph node type. Idempotent: calling
 * twice with the same block id replaces the previous registration
 * (litegraph logs `replacing node type` internally).
 *
 * @param {BlockDef} block
 * @param {any} LiteGraph    Pass `globalThis.LiteGraph`. Param is injected for tests.
 * @returns {string} the registered type name
 */
export function registerBlock(block, LiteGraph) {
  if (!LiteGraph) throw new Error("registerBlock: LiteGraph is required");

  const type = typeName(block);

  function NodeCtor() {
    // `this` is an LGraphNode instance because litegraph copies
    // LGraphNode.prototype onto NodeCtor.prototype at register time.
    const self = /** @type {any} */ (this);
    self.properties = self.properties || {};

    for (const inPort of block.inputs) {
      if (inPort.repeatable) {
        // Expand repeatable inputs to their declared minimum count so
        // a freshly-spawned node has the right number of bracket-indexed
        // slots even before an ELX import overrides `<port_group>`.
        const min = inPort.min ?? 0;
        for (let i = 0; i < min; i++) {
          self.addInput(`${inPort.name} [${i}]`, slotTypeFor(inPort), { _port: inPort });
        }
      } else {
        self.addInput(inPort.name, slotTypeFor(inPort), { _port: inPort });
      }
    }
    for (const outPort of block.outputs) {
      self.addOutput(outPort.name, slotTypeFor(outPort), { _port: outPort });
    }
    for (const param of block.parameters) {
      addParameterWidget(self, param);
    }
    // Stamp port_group state and install +/- widgets for repeatable
    // inputs. The importer overrides this with the live `<port_group>`
    // sizes when re-hydrating an ELX node.
    self._portGroups = defaultGroupsFor(block);
    attachPortGroupControls(self);
  }

  // Live veto for invalid connections. Litegraph fires onConnectInput
  // with the *source* slot info; we compare port defs via isValidConnection.
  NodeCtor.prototype.onConnectInput = function (
    /** @type {number} */ targetSlot,
    /** @type {string} */ _outType,
    /** @type {any} */ outSlot,
    /** @type {any} */ _outNode,
    /** @type {number} */ _outIdx,
  ) {
    const self = /** @type {any} */ (this);
    const inSlot = self.inputs && self.inputs[targetSlot];
    return isValidConnection(outSlot && outSlot._port, inSlot && inSlot._port);
  };

  NodeCtor.title = block.name || block.id;
  // `desc` shows in litegraph's right-click "About" / hover-help.
  NodeCtor.desc = block.descriptions?.short || block.descriptions?.long || "";

  LiteGraph.registerNodeType(type, NodeCtor);
  return type;
}

/**
 * Register every block of a plugin. Returns the list of type names
 * registered, in source order.
 *
 * @param {import("../plugins/parse.js").PluginDef} plugin
 * @param {any} LiteGraph
 * @returns {string[]}
 */
export function registerPlugin(plugin, LiteGraph) {
  /** @type {string[]} */
  const out = [];
  /** @param {BlockDef[]} blocks */
  const visit = (blocks) => {
    for (const b of blocks) out.push(registerBlock(b, LiteGraph));
  };
  /** @param {import("../plugins/parse.js").GroupDef[]} groups */
  const walkGroups = (groups) => {
    for (const g of groups) {
      visit(g.blocks);
      walkGroups(g.groups);
    }
  };
  visit(plugin.blocks);
  walkGroups(plugin.groups);
  return out;
}

/**
 * Litegraph-native check whether two slots can be connected. Strict on
 * structure (intersection must be non-empty), union on value
 * (intersection must be non-empty), "any" wildcards everything. See
 * OPEN-QUESTIONS Q3 for the working policy.
 *
 * Pass the slot's `_port` (the PortDef stashed at registration time);
 * if either side is missing, fall back to permissive.
 *
 * @param {PortDef|undefined} outPort
 * @param {PortDef|undefined} inPort
 * @returns {boolean}
 */
export function isValidConnection(outPort, inPort) {
  if (!outPort || !inPort) return true; // unknown -> allow

  const outStructs = portStructures(outPort);
  const inStructs = portStructures(inPort);
  if (outStructs.length && inStructs.length && !setsIntersect(outStructs, inStructs)) {
    return false;
  }

  const outValues = portValues(outPort);
  const inValues = portValues(inPort);
  // Port with no declared values is treated as "any" — accepts everything.
  if (outValues.length === 0 || inValues.length === 0) return true;
  return setsIntersect(outValues, inValues);
}

/**
 * @param {PortDef} port
 * @returns {string}
 */
function slotTypeFor(port) {
  const ids = portValues(port);
  if (ids.length === 0) return "*"; // litegraph wildcard
  return ids.join(",");
}

/**
 * @param {PortDef} port
 * @returns {string[]}
 */
function portValues(port) {
  /** @type {string[]} */
  const out = [];
  for (const v of port.values) {
    if (v.id && !out.includes(v.id)) out.push(v.id);
  }
  return out;
}

/**
 * @param {PortDef} port
 * @returns {string[]}
 */
function portStructures(port) {
  /** @type {string[]} */
  const out = [];
  for (const s of port.structures) {
    if (s.id && !out.includes(s.id)) out.push(s.id);
  }
  return out;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function setsIntersect(a, b) {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

/**
 * Attach one parameter widget to a node instance.
 *
 * @param {any} node    LGraphNode instance.
 * @param {ParameterDef} param
 */
function addParameterWidget(node, param) {
  const valueId = param.default?.id || "";
  const raw = param.default?.data ?? "";
  const label = param.name || param.id;

  if (valueId === "boolean") {
    const initial = raw === "true";
    node.properties[param.id] = initial;
    node.addWidget(
      "toggle",
      label,
      initial,
      (/** @type {any} */ v) => { node.properties[param.id] = !!v; },
      { property: param.id, on: "true", off: "false" }
    );
    return;
  }

  if (valueId === "integer") {
    const initial = Number.parseInt(raw, 10);
    const safe = Number.isFinite(initial) ? initial : 0;
    node.properties[param.id] = safe;
    node.addWidget(
      "number",
      label,
      safe,
      (/** @type {any} */ v) => { node.properties[param.id] = Number(v) | 0; },
      { property: param.id, step: 10, precision: 0 }
    );
    return;
  }

  // string, json, filesystem path, error-code, unknown -> text widget.
  node.properties[param.id] = raw;
  node.addWidget(
    "text",
    label,
    raw,
    (/** @type {any} */ v) => { node.properties[param.id] = String(v); },
    { property: param.id }
  );
}
