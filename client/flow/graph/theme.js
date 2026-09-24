// @ts-check
// Copied from wireon-process-editor src/graph/theme.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// split into themetokens.js (the palette), this file (the install) and
// themedraw.js (the drawing) for the 400-line rule; every literal colour is
// now a token read from hud.css, and the fonts are the page's own; and the
// canvas argument is optional, so the prototype half can be installed before
// any node type is registered. It has to be: LiteGraph.registerNodeType copies
// LGraphNode.prototype onto each type as it is registered, so a type
// registered before this runs keeps the unpatched getConnectionPos and its
// ports sit where the theme did not put them.
/**
 * Wireon design theme for litegraph.
 *
 * `applyWireonTheme(canvas, graph)` mutates global LiteGraph constants
 * and replaces several LGraphCanvas / LGraphNode prototype methods so
 * the rendered flow matches `docs/DESIGN.md`:
 *
 *   - a canvas the colour of the chrome's panels, no grid, no shadows
 *   - sharp-cornered nodes with 2px ink borders and 22px title bars in
 *     the view's own hue
 *   - 10x10 ink square ports straddling the node edge
 *   - 2px ink cubic-bezier wires with horizontal control vectors
 *   - 3px selection border (no colored glow)
 *   - 4px diagonal hatch fill for unknown-block bodies
 *
 * Each override is annotated with the design rule it implements.
 *
 * Idempotent: calling it twice is a no-op. Safe to call from
 * `main.js` right after constructing the canvas.
 */

import { palette, TITLE_HEIGHT, WIRE_WIDTH, titleFont, slotFont, idFont, CANVAS, GRID,
  GRID_STEP }
  from "./themetokens.js";
import { wireonDrawNodeShape, wireonDrawNode, wireonRenderLink, updateHoveredSlot }
  from "./themedraw.js";

let applied = false;


/**
 * Install the Wireon visual theme on the given canvas. The graph
 * argument is only used to trigger a redraw after install.
 *
 * @param {any} [canvas]     Instance of LGraphCanvas; omitted to install only
 *                           the global and prototype half, before any node
 *                           type has been registered.
 * @param {any} [graph]      Optional LGraph; passed so we can mark it dirty.
 */
export function applyWireonTheme(canvas, graph) {
  const g = /** @type {any} */ (globalThis);
  const LiteGraph = g.LiteGraph;
  const LGraphCanvas = g.LGraphCanvas;
  const LGraphNode = g.LGraphNode;
  if (!LiteGraph || !LGraphCanvas || !LGraphNode) {
    throw new Error("applyWireonTheme: litegraph globals are not available");
  }

  if (!applied) {
    applyGlobalConstants(LiteGraph);
    patchNodePrototype(LGraphNode, LiteGraph);
    patchCanvasPrototype(LGraphCanvas, LiteGraph);
    applied = true;
  }

  if (canvas) applyCanvasInstanceSettings(canvas);
  if (graph) graph.setDirtyCanvas(true, true);
}

/* ----------------------------- globals ------------------------------ */

/**
 * Color/shape constants that surface on every node and widget. Setting
 * these means most of the dark palette disappears without touching
 * draw methods. Anything still rendering as gray is handled by the
 * draw-method overrides below.
 *
 * @param {any} LiteGraph
 */
function applyGlobalConstants(LiteGraph) {
  const { fg: FG, bg: BG, accent: ACCENT, on: ON, edge: EDGE } = palette();
  // Node body and title bar.
  LiteGraph.NODE_DEFAULT_BGCOLOR = BG;     // white body fill
  LiteGraph.NODE_DEFAULT_COLOR = ACCENT;   // title bar fill (the view's hue)
  LiteGraph.NODE_DEFAULT_BOXCOLOR = FG;    // status dot (used when low-quality)
  LiteGraph.NODE_TITLE_COLOR = ON;         // title text, drawn on the hue
  LiteGraph.NODE_SELECTED_TITLE_COLOR = ON;
  LiteGraph.NODE_TEXT_COLOR = FG;          // slot labels, widget text
  LiteGraph.NODE_BOX_OUTLINE_COLOR = FG;

  // Sharp rectangular shape is the only one we ever want.
  LiteGraph.NODE_DEFAULT_SHAPE = LiteGraph.BOX_SHAPE;

  // 22px title bar instead of the default 30.
  LiteGraph.NODE_TITLE_HEIGHT = TITLE_HEIGHT;
  // Vertical baseline for the title text (was 20).
  LiteGraph.NODE_TITLE_TEXT_Y = 15;

  // Widgets (the toggle/number/text controls inside a node).
  LiteGraph.WIDGET_BGCOLOR = BG;
  LiteGraph.WIDGET_OUTLINE_COLOR = EDGE;
  LiteGraph.WIDGET_TEXT_COLOR = FG;
  LiteGraph.WIDGET_SECONDARY_TEXT_COLOR = EDGE;

  // Wire colors. The actual stroke is set by the renderLink override
  // but litegraph still consults these for the "currently connecting"
  // preview line.
  LiteGraph.LINK_COLOR = FG;
  LiteGraph.EVENT_LINK_COLOR = FG;
  LiteGraph.CONNECTING_LINK_COLOR = FG;

  // No drop shadow under nodes.
  LiteGraph.DEFAULT_SHADOW_COLOR = "transparent";
}

/**
 * Per-canvas-instance flags. These are properties on LGraphCanvas (not
 * the prototype), so they have to be reapplied each time a canvas is
 * constructed. The theme keeps no state otherwise.
 *
 * @param {any} canvas
 */
function applyCanvasInstanceSettings(canvas) {
  const { fg: FG } = palette();
  // Solid white. No grid, no border, no shadows.
  canvas.clear_background = true;
  // Design 10a: the canvas is its own dark ground with a 40px grid, and
  // litegraph's debug readout (T / I / N / V / FPS) is not shown.
  canvas.clear_background_color = CANVAS;
  canvas.show_info = false;
  canvas.onDrawBackground = drawGrid;
  canvas.background_image = null;           // disables the dot-grid pattern
  canvas._pattern = null;
  canvas._pattern_img = null;
  canvas._bg_img = null;
  canvas.render_canvas_border = false;
  canvas.render_shadows = false;
  canvas.render_connections_shadows = false;
  canvas.render_connections_border = false;
  canvas.render_curved_connections = true;
  canvas.use_gradients = false;
  canvas.render_title_colored = true;       // honor NODE_DEFAULT_COLOR
  canvas.render_connection_arrows = false;

  // Wires.
  canvas.default_link_color = FG;
  canvas.connections_width = WIRE_WIDTH;
  canvas.links_render_mode = (/** @type {any} */ (globalThis)).LiteGraph.SPLINE_LINK;

  // Fonts.
  canvas.title_text_font = titleFont();
  canvas.inner_text_font = slotFont();
  canvas.node_title_color = palette().on;   // title text, drawn on the hue
  canvas.editor_alpha = 1;
}

/**
 * The grid, in graph space so it moves and scales with the blocks.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} area  [x, y, w, h] of what is visible, in graph space
 */
function drawGrid(ctx, area) {
  if (!area) return;
  const [x, y, w, h] = area;
  ctx.save();
  ctx.fillStyle = GRID;
  const x0 = Math.floor(x / GRID_STEP) * GRID_STEP;
  const y0 = Math.floor(y / GRID_STEP) * GRID_STEP;
  for (let gx = x0; gx < x + w; gx += GRID_STEP) ctx.fillRect(gx, y, 1, h);
  for (let gy = y0; gy < y + h; gy += GRID_STEP) ctx.fillRect(x, gy, w, 1);
  ctx.restore();
}

/* ----------------------------- nodes -------------------------------- */

/**
 * Replace node-side methods that decide where wires attach and how
 * the node was previously drawn. The slot rendering itself lives in
 * the canvas override (drawNode) because that's where litegraph
 * decided to keep it.
 *
 * @param {any} LGraphNode
 * @param {any} LiteGraph
 */
function patchNodePrototype(LGraphNode, LiteGraph) {
  // Slots straddle the node edge (half outside, half inside).
  // Original litegraph offsets by NODE_SLOT_HEIGHT/2 *into* the node;
  // we override so the connection point sits *on* the edge.
  LGraphNode.prototype.getConnectionPos = wireonGetConnectionPos;
  // Design 10a draws a block wide enough for its title in capitals and its
  // plugin id beside it; litegraph's own measure is for a smaller font.
  const measure = LGraphNode.prototype.computeSize;
  LGraphNode.prototype.computeSize = function (/** @type {any} */ out) {
    const size = measure.call(this, out);
    size[0] = Math.max(size[0], wanted(this));
    return size;
  };
}

/** @type {CanvasRenderingContext2D | null} */
let ruler = null;

/**
 * How wide a block has to be for its head and its widest row, in the fonts
 * themedraw.js uses.
 *
 * @param {any} node
 */
function wanted(node) {
  ruler = ruler || document.createElement("canvas").getContext("2d");
  if (!ruler) return 180;
  const width = (/** @type {string} */ font, /** @type {string} */ text) => {
    /** @type {CanvasRenderingContext2D} */ (ruler).font = font;
    return /** @type {CanvasRenderingContext2D} */ (ruler).measureText(text).width;
  };
  const id = node._irPlugin && node._irNodeId ? `${node._irPlugin}/${node._irNodeId}` : "";
  const title = String(node.title ?? "").toUpperCase();
  const head = width(titleFont(), title) + title.length * 0.9
    + (id ? Math.min(width(idFont(), id), 150) + 8 : 0) + 16;
  let rows = 0;
  const n = Math.max(node.inputs?.length ?? 0, node.outputs?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const a = node.inputs?.[i];
    const b = node.outputs?.[i];
    rows = Math.max(rows, (a ? width(slotFont(), a.label ?? a.name ?? "") : 0)
      + (b ? width(slotFont(), b.label ?? b.name ?? "") : 60) + 40);
  }
  return Math.min(Math.max(180, head, rows), 260);
}

/**
 * @this {any}
 * @param {boolean} is_input
 * @param {number} slot_number
 * @param {Float32Array} [out]
 */
function wireonGetConnectionPos(is_input, slot_number, out) {
  const g = /** @type {any} */ (globalThis);
  const LiteGraph = g.LiteGraph;
  out = out || new Float32Array(2);

  // Collapsed and explicit-pos slots: defer to the design "ports sit
  // on the edge" rule by clamping x to the relevant edge regardless.
  if (this.flags && this.flags.collapsed) {
    const w = this._collapsed_width || LiteGraph.NODE_COLLAPSED_WIDTH;
    out[0] = is_input ? this.pos[0] : this.pos[0] + w;
    out[1] = this.pos[1] - LiteGraph.NODE_TITLE_HEIGHT * 0.5;
    return out;
  }

  const slots = is_input ? this.inputs : this.outputs;
  const slot = slots && slots[slot_number];
  if (slot && slot.pos) {
    // Honor explicit per-slot positions (used by some node types) but
    // still snap x to the edge.
    out[0] = this.pos[0] + (is_input ? 0 : this.size[0]);
    out[1] = this.pos[1] + slot.pos[1];
    return out;
  }

  // Vertical distribution, identical to litegraph default.
  const startY = this.constructor.slot_start_y || 0;
  out[0] = is_input ? this.pos[0] : this.pos[0] + this.size[0];
  out[1] = this.pos[1] + (slot_number + 0.7) * LiteGraph.NODE_SLOT_HEIGHT + startY;
  return out;
}

/* ----------------------------- canvas ------------------------------- */

/**
 * @param {any} LGraphCanvas
 * @param {any} LiteGraph
 */
function patchCanvasPrototype(LGraphCanvas, LiteGraph) {
  LGraphCanvas.prototype.drawNodeShape = wireonDrawNodeShape;
  LGraphCanvas.prototype.drawNode = wireonDrawNode;
  LGraphCanvas.prototype.renderLink = wireonRenderLink;

  // Hook mousemove to detect port hover for the grow-on-hover rule.
  // Original `processMouseMove` is preserved and invoked first; we
  // just decorate to track the hovered slot.
  const origMouseMove = LGraphCanvas.prototype.processMouseMove;
  LGraphCanvas.prototype.processMouseMove = function (/** @type {any} */ e) {
    const r = origMouseMove.call(this, e);
    updateHoveredSlot(this, e);
    return r;
  };
}

/**
 * Test-only helper. Re-enables applyWireonTheme on the next call.
 */
export function _resetWireonThemeFlag() {
  applied = false;
}
