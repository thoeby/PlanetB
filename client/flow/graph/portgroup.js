// @ts-check
// Copied from wireon-process-editor src/graph/portgroup.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Variable-arity port (port_group) helpers.
 *
 * Plugin XML declares a repeatable input with `<input type="group"
 * min="N">`. The ELX export of an instance records the live count as
 * `<port_group id="in" size="N">`. The importer (`import.js`) expands
 * `<port_group>` into N bracket-indexed slots ("in [0]", "in [1]", …)
 * and stamps `node._portGroups` so the +/- controls here can find the
 * template later.
 *
 * `attachPortGroupControls` adds `+` / `−` button widgets to a node so
 * users can grow or shrink the arity from the canvas. The same actions
 * are also wired into the properties panel (`src/ui/properties.js`).
 *
 * Removal is conservative: only the *last* slot is droppable, and only
 * if it has no incoming link. Asking to remove a wired slot is a no-op
 * with a console.warn — we never silently drop links.
 */

import { markGraphDirty } from "./history.js";

/** @typedef {import("../plugins/parse.js").BlockDef} BlockDef */
/** @typedef {import("../plugins/parse.js").PortDef} PortDef */

/**
 * Per-node bookkeeping for one expanded port group. Stamped on the
 * node by `import.js` and refreshed by `addPort` / `removePort`.
 *
 * @typedef {Object} PortGroupState
 * @property {string} id              Group/port name as it appears in plugin XML ("in").
 * @property {number} size            Current number of expanded slots.
 * @property {number} min             Minimum size from plugin XML (default 0).
 * @property {string} slotType        Litegraph slot type string ("string,filesystem path", "*", …).
 * @property {PortDef} [template]     The plugin-side declaration; carried for isValidConnection.
 */

/**
 * Build the litegraph slot type from a port def. Mirrors the helper in
 * `import.js` / `register.js`; kept private here to avoid pulling those
 * modules into this file (they pull in litegraph).
 *
 * @param {PortDef | undefined} port
 */
export function slotTypeFromPort(port) {
  if (!port) return "*";
  /** @type {string[]} */
  const ids = [];
  for (const v of port.values) if (v.id && !ids.includes(v.id)) ids.push(v.id);
  return ids.length ? ids.join(",") : "*";
}

/**
 * Discover any repeatable groups declared on the block but not present
 * as `<port_group>` on the IR node. We default their size to the
 * minimum declared in the plugin XML (or 0 if none).
 *
 * @param {BlockDef | null} block
 * @returns {PortGroupState[]}
 */
export function defaultGroupsFor(block) {
  if (!block) return [];
  /** @type {PortGroupState[]} */
  const out = [];
  for (const inp of block.inputs) {
    if (!inp.repeatable) continue;
    out.push({
      id: inp.name,
      size: inp.min ?? 0,
      min: inp.min ?? 0,
      slotType: slotTypeFromPort(inp),
      template: inp,
    });
  }
  return out;
}

/**
 * Add one more port to the named group. Returns the new size, or -1 if
 * the group is unknown.
 *
 * @param {any} node
 * @param {string} groupId
 */
export function addPort(node, groupId) {
  const state = findState(node, groupId);
  if (!state) return -1;
  const newIdx = state.size;
  node.addInput(
    `${groupId} [${newIdx}]`,
    state.slotType,
    state.template ? { _port: state.template } : undefined,
  );
  state.size = newIdx + 1;
  return state.size;
}

/**
 * Drop the last port of the group, but only when unwired. Returns the
 * new size, -1 if the group is unknown, -2 if the size is already at
 * the declared minimum, -3 if the last slot is still connected.
 *
 * @param {any} node
 * @param {string} groupId
 */
export function removePort(node, groupId) {
  const state = findState(node, groupId);
  if (!state) return -1;
  if (state.size <= state.min) return -2;

  const lastName = `${groupId} [${state.size - 1}]`;
  const inputs = node.inputs || [];
  // Search from the end — the typical case is the slot we're removing
  // is the literal last one.
  let idx = -1;
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (inputs[i].name === lastName) { idx = i; break; }
  }
  if (idx < 0) return -1;

  if (inputs[idx].link != null) return -3;
  node.removeInput(idx);
  state.size = state.size - 1;
  return state.size;
}

/**
 * Attach `+` / `−` widgets to a node, one pair per discovered group.
 * Idempotent: walking the widget list and skipping already-installed
 * controls means re-running on the same node is safe.
 *
 * The widgets are litegraph "button" widgets — they paint as small
 * round buttons under the node body and fire their callback on click.
 *
 * @param {any} node
 * @param {() => void} [onChange]   Optional hook fired after a successful add/remove.
 */
export function attachPortGroupControls(node, onChange) {
  if (!node._portGroups || node._portGroups.length === 0) return;
  for (const state of node._portGroups) {
    const tag = `__pg:${state.id}`;
    const already = (node.widgets || []).some(
      (/** @type {any} */ w) => w.options && w.options._portGroupTag === tag,
    );
    if (already) continue;

    node.addWidget(
      "button",
      `+ ${state.id}`,
      null,
      () => {
        const n = addPort(node, state.id);
        if (n > 0) {
          markGraphDirty(node.graph);
          if (onChange) onChange();
        }
      },
      { _portGroupTag: tag },
    );
    node.addWidget(
      "button",
      `− ${state.id}`,
      null,
      () => {
        const r = removePort(node, state.id);
        if (r === -3) {
          console.warn(`port_group "${state.id}": last slot still wired; disconnect it first`);
        }
        if (r >= 0) {
          markGraphDirty(node.graph);
          if (onChange) onChange();
        }
      },
      { _portGroupTag: tag },
    );
  }
}

/**
 * @param {any} node
 * @param {string} groupId
 * @returns {PortGroupState | null}
 */
function findState(node, groupId) {
  if (!node._portGroups) return null;
  for (const s of node._portGroups) if (s.id === groupId) return s;
  return null;
}
