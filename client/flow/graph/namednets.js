// @ts-check
// Copied from wireon-process-editor src/graph/namednets.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Named-net rendering polish (Phase 12 — optional v1).
 *
 * Auto-named nets carry IDs like "N001", "N028"; user-named nets get
 * something like "target", "albumlist". For user-named nets we offer a
 * per-net toggle that swaps the visible wire for a small text badge
 * rendered on each connected slot.
 *
 * State model:
 *   - `graph._irLinkToNet`         Map<linkId, netName>          (set by import)
 *   - `graph._irNetModes`          Map<netName, "wires"|"labels">  (lazily created)
 *
 * Rendering hooks:
 *   - LGraphCanvas.prototype.renderLink — wrapped to no-op when the
 *     link belongs to a "labels"-mode net.
 *   - LGraphCanvas.prototype.onDrawForeground — appended to draw the
 *     badges in graph space.
 *
 * `installNamedNetRendering(graphCanvas)` is idempotent: the wrappers
 * stash a flag on the canvas prototype so calling it twice is a no-op.
 */

const AUTO_NET_RE = /^N\d+$/;

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isUserNamedNet(name) {
  return !!name && !AUTO_NET_RE.test(name);
}

/**
 * Walk the graph's net-name table and return the set of user-named
 * nets actually in use.
 *
 * @param {any} graph
 * @returns {string[]}    Sorted lexicographically for stable UI order.
 */
export function userNamedNets(graph) {
  /** @type {Set<string>} */
  const set = new Set();
  const linkToNet = graph && graph._irLinkToNet;
  if (!linkToNet) return [];
  for (const name of linkToNet.values()) {
    if (isUserNamedNet(name)) set.add(name);
  }
  return [...set].sort();
}

/**
 * @param {any} graph
 * @returns {Map<string, "wires"|"labels">}
 */
function modes(graph) {
  if (!graph._irNetModes) graph._irNetModes = new Map();
  return graph._irNetModes;
}

/**
 * @param {any} graph
 * @param {string} netName
 * @returns {"wires"|"labels"}
 */
export function getNetMode(graph, netName) {
  return modes(graph).get(netName) || "wires";
}

/**
 * @param {any} graph
 * @param {string} netName
 * @param {"wires"|"labels"} mode
 */
export function setNetMode(graph, netName, mode) {
  modes(graph).set(netName, mode);
  applyHiddenFlags(graph);
}

/**
 * Refresh `link._hidden` based on the current mode table. Called from
 * `setNetMode`; also called after import to seed the initial state.
 *
 * @param {any} graph
 */
export function applyHiddenFlags(graph) {
  const linkToNet = graph && graph._irLinkToNet;
  const m = modes(graph);
  if (!linkToNet || !graph.links) return;
  for (const lid of Object.keys(graph.links)) {
    const link = graph.links[lid];
    if (!link) continue;
    const nm = linkToNet.get(Number(lid));
    link._hidden = !!(nm && m.get(nm) === "labels");
  }
}

/**
 * Install the rendering hooks on LGraphCanvas. Idempotent.
 *
 * @param {any} LGraphCanvas
 */
export function installNamedNetRendering(LGraphCanvas) {
  if (!LGraphCanvas || LGraphCanvas.prototype._wireonNamedNetsPatched) return;
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
    if (link && link._hidden) return;
    return protoRenderLink.call(
      this, ctx, a, b, link, skip_border, flow, color, start_dir, end_dir, num_sublines,
    );
  };

  const protoFG = LGraphCanvas.prototype.onDrawForeground;
  LGraphCanvas.prototype.onDrawForeground = function (/** @type {any} */ ctx) {
    if (protoFG) protoFG.call(this, ctx);
    drawNetBadges(this, ctx);
  };

  LGraphCanvas.prototype._wireonNamedNetsPatched = true;
}

/**
 * Draw the per-slot name badges for any "labels"-mode net.
 *
 * @param {any} graphCanvas
 * @param {CanvasRenderingContext2D} ctx
 */
function drawNetBadges(graphCanvas, ctx) {
  const graph = graphCanvas.graph;
  if (!graph) return;
  const linkToNet = graph._irLinkToNet;
  const m = graph._irNetModes;
  if (!linkToNet || !m || m.size === 0) return;

  ctx.save();
  ctx.font = "10px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";

  const nodes = graph._nodes || [];
  const seenSource = new Set();
  for (const node of nodes) {
    // Inputs
    if (node.inputs) {
      for (let i = 0; i < node.inputs.length; i++) {
        const slot = node.inputs[i];
        if (!slot || slot.link == null) continue;
        const link = graph.links[slot.link];
        if (!link) continue;
        const nm = linkToNet.get(Number(slot.link));
        if (!nm || m.get(nm) !== "labels") continue;
        const p = node.getConnectionPos(true, i);
        drawBadge(ctx, nm, p[0] + 8, p[1], "left");
      }
    }
    // Outputs — collect once per (node, slot) since multiple links share it.
    if (node.outputs) {
      for (let o = 0; o < node.outputs.length; o++) {
        const slot = node.outputs[o];
        if (!slot || !slot.links || slot.links.length === 0) continue;
        let chosen = null;
        for (const lid of slot.links) {
          const nm = linkToNet.get(Number(lid));
          if (nm && m.get(nm) === "labels") { chosen = nm; break; }
        }
        if (!chosen) continue;
        const key = node.id + ":" + o + ":" + chosen;
        if (seenSource.has(key)) continue;
        seenSource.add(key);
        const p = node.getConnectionPos(false, o);
        drawBadge(ctx, chosen, p[0] - 8, p[1], "right");
      }
    }
  }
  ctx.restore();
}

/**
 * Render one badge: a tiny pill-shaped rectangle with the net name.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {"left"|"right"} anchor
 */
function drawBadge(ctx, text, x, y, anchor) {
  const padding = 4;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 14;
  const left = anchor === "left" ? x : x - width;
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.beginPath();
  ctx.rect(left, y - height / 2, width, height);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(text, left + padding, y);
}
