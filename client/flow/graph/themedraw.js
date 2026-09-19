// @ts-check
// Copied from wireon-process-editor src/graph/theme.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the drawing half of that file, split out for the 400-line rule; the colours
// come from themetokens.js rather than from black-and-white literals.
/**
 * How a themed litegraph draws a node, its ports and its wires. Each of these
 * replaces one of LGraphCanvas's own methods; theme.js installs them.
 */

import {
  palette, TITLE_PAD_LEFT, PORT_SIZE, PORT_HOVER_SIZE, SELECT_BORDER_WIDTH,
  HATCH_STEP, WIRE_WIDTH, titleFont, slotFont,
} from "./themetokens.js";

/**
 * Custom node shape: white rect, 2px (or 3px when selected) black
 * border, full-width black title bar 22px tall. Implements the design
 * rules under "Nodes" in docs/DESIGN.md.
 *
 * @this {any}
 * @param {any} node
 * @param {CanvasRenderingContext2D} ctx
 * @param {Float32Array} size
 * @param {string} _fgcolor
 * @param {string} _bgcolor
 * @param {boolean} selected
 */
export function wireonDrawNodeShape(node, ctx, size, _fgcolor, _bgcolor, selected) {
  const { fg: FG, bg: BG, accent: ACCENT, on: ON } = palette();
  const g = /** @type {any} */ (globalThis);
  const LiteGraph = g.LiteGraph;
  const titleH = LiteGraph.NODE_TITLE_HEIGHT;
  const w = size[0];
  const h = size[1];

  // Optional hatch pattern for placeholder nodes (design rule
  // "Unknown-block render"). Drawn behind the white fill so the
  // border still wins.
  if (node._irPlaceholder) {
    drawHatchedRect(ctx, 0, -titleH, w, h + titleH);
  } else {
    ctx.fillStyle = BG;
    ctx.fillRect(0, -titleH, w, h + titleH);
  }

  // Title bar.
  // The title bar is the view's hue (FND.1: accent = the app hue), not ink.
  ctx.fillStyle = node.color || node.constructor.color || ACCENT;
  ctx.fillRect(0, -titleH, w, titleH);

  // Title text. 600 13px Inter, 12px padding-left, baseline mid-bar.
  ctx.font = titleFont();
  ctx.fillStyle = ON;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const title = node.getTitle ? node.getTitle() : node.title;
  if (title) ctx.fillText(String(title), TITLE_PAD_LEFT, -titleH * 0.5);
  ctx.textBaseline = "alphabetic";

  // Border. 2px normally, 3px when selected (replaces the colored glow).
  ctx.strokeStyle = selected ? ACCENT : FG;
  ctx.lineWidth = selected ? SELECT_BORDER_WIDTH : 2;
  // strokeRect strokes on the centerline; the offset keeps the border
  // visually flush with the body fill rather than half outside it.
  const off = ctx.lineWidth * 0.5;
  ctx.strokeRect(off, -titleH + off, w - ctx.lineWidth, h + titleH - ctx.lineWidth);
}

/**
 * 4px diagonal hatch (design rule under "Nodes"). Drawn directly
 * rather than via createPattern so the hatch doesn't anti-alias
 * differently as the canvas zooms.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function drawHatchedRect(ctx, x, y, w, h) {
  const { fg: FG, bg: BG } = palette();
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = FG;
  ctx.lineWidth = 1;
  for (let d = -h; d < w + h; d += HATCH_STEP) {
    ctx.beginPath();
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Full replacement for LGraphCanvas.drawNode. The default
 * implementation draws round ports and bakes a lot of unrelated styling
 * (gradients, alphas, status dots) directly into the function. We
 * keep the structure (shape, foreground, slots, widgets) but render
 * slots as 10x10 black squares centered on the node edge per
 * docs/DESIGN.md "Ports".
 *
 * @this {any}
 * @param {any} node
 * @param {CanvasRenderingContext2D} ctx
 */
export function wireonDrawNode(node, ctx) {
  const { fg: FG, bg: BG } = palette();
  const g = /** @type {any} */ (globalThis);
  const LiteGraph = g.LiteGraph;
  this.current_node = node;

  ctx.shadowColor = "transparent"; // belt-and-braces: no shadows
  ctx.globalAlpha = 1;

  // Shape, title bar, border, selection highlight.
  this.drawNodeShape(
    node,
    ctx,
    node.size,
    FG,
    BG,
    node.is_selected,
    node.mouseOver
  );

  if (node.onDrawForeground) {
    node.onDrawForeground(ctx, this, this.canvas);
  }

  if (node.flags && node.flags.collapsed) {
    // Collapsed nodes still need slot stubs but the default doesn't
    // draw the body, so don't try to enumerate slots either.
    ctx.globalAlpha = 1;
    return;
  }

  // Slot rendering. Ports are 10x10 (or 12x12 when hovered) black
  // squares centered on x=0 (inputs) or x=size[0] (outputs).
  const hovered = this._wireonHoveredSlot;
  ctx.fillStyle = FG;
  ctx.strokeStyle = FG;
  ctx.lineWidth = 1;
  ctx.font = slotFont();

  drawSlots(ctx, node, true, hovered);
  drawSlots(ctx, node, false, hovered);

  if (node.widgets) {
    // Litegraph computes a per-frame `max_y` to start widgets below the
    // last slot. We mirror that with the slot count formula in the
    // default computeSize so widgets always sit under the slots.
    const maxSlots = Math.max(
      node.inputs ? node.inputs.length : 0,
      node.outputs ? node.outputs.length : 0
    );
    const widgetsY = maxSlots * LiteGraph.NODE_SLOT_HEIGHT + 4;
    this.drawNodeWidgets(
      node,
      widgetsY,
      ctx,
      this.node_widget && this.node_widget[0] === node ? this.node_widget[1] : null
    );
  }
  ctx.globalAlpha = 1;
}

/**
 * Draw the input or output slot column for a node. Per design: 10×10
 * black squares centered on the node edge, growing to 12×12 on hover.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} node
 * @param {boolean} isInput
 * @param {{node:any,isInput:boolean,index:number}|null} hovered
 */
function drawSlots(ctx, node, isInput, hovered) {
  const { fg: FG } = palette();
  const slots = isInput ? node.inputs : node.outputs;
  if (!slots) return;
  const tmp = new Float32Array(2);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const isHovered =
      hovered && hovered.node === node && hovered.isInput === isInput && hovered.index === i;
    const sz = isHovered ? PORT_HOVER_SIZE : PORT_SIZE;
    const pos = node.getConnectionPos(isInput, i, tmp);
    const x = pos[0] - node.pos[0];
    const y = pos[1] - node.pos[1];
    ctx.fillStyle = FG;
    ctx.fillRect(x - sz * 0.5, y - sz * 0.5, sz, sz);

    // Slot label inside the body. Skip when the label is empty so the
    // pseudo-input "port" name doesn't get drawn.
    const text = slot.label != null ? slot.label : slot.name;
    if (text) {
      ctx.fillStyle = FG;
      ctx.textBaseline = "middle";
      if (isInput) {
        ctx.textAlign = "left";
        ctx.fillText(text, x + PORT_SIZE, y);
      } else {
        ctx.textAlign = "right";
        ctx.fillText(text, x - PORT_SIZE, y);
      }
      ctx.textBaseline = "alphabetic";
    }
  }
}

/**
 * Track which slot the mouse is over so drawSlots can grow it. Stored
 * on the canvas (not the node) so we only mark one slot at a time.
 *
 * @param {any} canvas
 * @param {MouseEvent} _e
 */
export function updateHoveredSlot(canvas, _e) {
  const g = /** @type {any} */ (globalThis);
  const LiteGraph = g.LiteGraph;
  const mouse = canvas.graph_mouse;
  if (!canvas.graph) return;
  const nodes = canvas.graph._nodes;
  /** @type {{node:any,isInput:boolean,index:number}|null} */
  let found = null;
  // Walk top-down so the topmost node wins when nodes overlap.
  for (let i = nodes.length - 1; i >= 0 && !found; i--) {
    const node = nodes[i];
    if (node.flags && node.flags.collapsed) continue;
    const r = PORT_HOVER_SIZE * 0.5 + 2;
    const tmp = new Float32Array(2);
    if (node.inputs) {
      for (let k = 0; k < node.inputs.length; k++) {
        const p = node.getConnectionPos(true, k, tmp);
        if (Math.abs(mouse[0] - p[0]) < r && Math.abs(mouse[1] - p[1]) < r) {
          found = { node, isInput: true, index: k };
          break;
        }
      }
    }
    if (!found && node.outputs) {
      for (let k = 0; k < node.outputs.length; k++) {
        const p = node.getConnectionPos(false, k, tmp);
        if (Math.abs(mouse[0] - p[0]) < r && Math.abs(mouse[1] - p[1]) < r) {
          found = { node, isInput: false, index: k };
          break;
        }
      }
    }
  }
  const prev = canvas._wireonHoveredSlot;
  const changed = !!found !== !!prev
    || (found && prev && (found.node !== prev.node || found.isInput !== prev.isInput || found.index !== prev.index));
  if (changed) {
    canvas._wireonHoveredSlot = found;
    canvas.setDirty(true, false);
  }
  // Silence unused-import lint; LiteGraph is referenced for future
  // expansion (e.g. distinguishing event-type slots).
  void LiteGraph;
}

/**
 * Custom link renderer. 2px solid black cubic-bezier with horizontal
 * control vectors per docs/DESIGN.md "Wires". Matches the curve in
 * the SVG mockup so wires fan out horizontally even when source and
 * sink have very different y-coordinates.
 *
 * @this {any}
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number,number]|Float32Array} a   Start pos
 * @param {[number,number]|Float32Array} b   End pos
 * @param {any} link
 */
export function wireonRenderLink(ctx, a, b, link /*, skip_border, flow, color, start_dir, end_dir, num_sublines */) {
  const { fg: FG } = palette();
  if (link) this.visible_links.push(link);

  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = 1;
  ctx.lineWidth = WIRE_WIDTH;
  ctx.strokeStyle = FG;
  ctx.fillStyle = FG;
  ctx.lineJoin = "round";

  const dx = Math.max(40, Math.abs(b[0] - a[0]));
  const c1x = a[0] + dx * 0.5;
  const c2x = b[0] - dx * 0.5;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.bezierCurveTo(c1x, a[1], c2x, b[1], b[0], b[1]);
  ctx.stroke();

  // Cache the link midpoint so hover/tooltip code keeps working.
  if (link && link._pos) {
    link._pos[0] = (a[0] + b[0]) * 0.5;
    link._pos[1] = (a[1] + b[1]) * 0.5;
  }
  ctx.restore();
}
