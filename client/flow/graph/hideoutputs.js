// @ts-check
// Copied from wireon-process-editor src/graph/hideoutputs.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Hidden output ports (Phase 18.3).
 *
 * The Block Settings "Outputs" tab can mark an output as not-visible.
 * Visibility is editor-only state stored in the layout sidecar — we
 * never touch the exporter, so a hidden output is still emitted to ELX
 * (we never lose data, per CLAUDE.md).
 *
 * State model:
 *   - `node._hiddenOutputs`   Set<string>   hidden output port names
 *   - `link._hiddenByOutput`  boolean       set by `applyHiddenOutputFlags`
 *
 * Rendering hooks (installed once, idempotent):
 *   - `renderLink` — wrapped to no-op for a link whose source output is
 *     hidden. This composes with the named-nets hook (which uses a
 *     separate `link._hidden` flag) — a link hidden by either is skipped.
 *   - `drawNode` — wrapped to omit hidden output slots from the node's
 *     `outputs` for the duration of the draw, so their connector dots
 *     and labels disappear.
 *
 * Caveat: omitting a slot mid-list compacts the dots drawn below it
 * (litegraph lays slots out by index), so visibility is best used on
 * trailing outputs (e.g. an unused `error`). Links are hidden too, so a
 * hidden output never shows a dangling dot. See OPEN-QUESTIONS §
 * "Block Settings dialog — constant editor & output hiding".
 */

/**
 * @param {any} node
 * @returns {Set<string>}
 */
function hiddenSet(node) {
  if (!node._hiddenOutputs) node._hiddenOutputs = new Set();
  return node._hiddenOutputs;
}

/**
 * @param {any} node
 * @param {string} name
 * @returns {boolean}
 */
export function isOutputHidden(node, name) {
  return !!(node._hiddenOutputs && node._hiddenOutputs.has(name));
}

/**
 * Toggle one output's visibility on the node (in-memory only — callers
 * persist via the sidecar and refresh link flags).
 *
 * @param {any} node
 * @param {string} name
 * @param {boolean} hidden
 */
export function setOutputHidden(node, name, hidden) {
  const set = hiddenSet(node);
  if (hidden) set.add(name);
  else set.delete(name);
}

/**
 * Recompute `link._hiddenByOutput` for every link from the current
 * per-node hidden sets. Call after import and after a toggle.
 *
 * @param {any} graph
 */
export function applyHiddenOutputFlags(graph) {
  if (!graph || !graph.links) return;
  const nodes = graph._nodes || [];
  /** @type {Map<number, any>} */
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);

  for (const lid of Object.keys(graph.links)) {
    const link = graph.links[lid];
    if (!link) continue;
    const src = byId.get(link.origin_id);
    let hidden = false;
    if (src && src._hiddenOutputs && src._hiddenOutputs.size && src.outputs) {
      const slot = src.outputs[link.origin_slot];
      if (slot && src._hiddenOutputs.has(slot.name)) hidden = true;
    }
    link._hiddenByOutput = hidden;
  }
}

/**
 * Install the rendering hooks on LGraphCanvas. Idempotent.
 *
 * @param {any} LGraphCanvas
 */
export function installHiddenOutputRendering(LGraphCanvas) {
  if (!LGraphCanvas || LGraphCanvas.prototype._wireonHiddenOutputsPatched) return;

  const protoRenderLink = LGraphCanvas.prototype.renderLink;
  LGraphCanvas.prototype.renderLink = function (
    /** @type {any} */ ctx,
    /** @type {any} */ a,
    /** @type {any} */ b,
    /** @type {any} */ link,
    /** @type {any} */ skip_border,
    /** @type {any} */ flow,
    /** @type {any} */ color,
    /** @type {any} */ start_dir,
    /** @type {any} */ end_dir,
    /** @type {any} */ num_sublines,
  ) {
    if (link && link._hiddenByOutput) return;
    return protoRenderLink.call(
      this, ctx, a, b, link, skip_border, flow, color, start_dir, end_dir, num_sublines,
    );
  };

  const protoDrawNode = LGraphCanvas.prototype.drawNode;
  LGraphCanvas.prototype.drawNode = function (/** @type {any} */ node, /** @type {any} */ ctx) {
    const hidden = node && node._hiddenOutputs;
    if (hidden && hidden.size && node.outputs && node.outputs.some((/** @type {any} */ o) => hidden.has(o.name))) {
      const saved = node.outputs;
      node.outputs = saved.filter((/** @type {any} */ o) => !hidden.has(o.name));
      try {
        return protoDrawNode.call(this, node, ctx);
      } finally {
        node.outputs = saved;
      }
    }
    return protoDrawNode.call(this, node, ctx);
  };

  LGraphCanvas.prototype._wireonHiddenOutputsPatched = true;
}
