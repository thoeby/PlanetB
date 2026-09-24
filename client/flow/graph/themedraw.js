// @ts-check
// Copied from wireon-process-editor src/graph/theme.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// the drawing half of that file, split out for the 400-line rule; the colours
// come from themetokens.js rather than from black-and-white literals; a node
// the chosen process server lacks (_irMissingOn, TASKS-flows.md FL.2) is
// hatched like a placeholder.
/**
 * How a themed litegraph draws a node, its ports and its wires. Each of these
 * replaces one of LGraphCanvas's own methods; theme.js installs them.
 */

import {
  palette, TITLE_PAD_LEFT, PORT_SIZE, PORT_HOVER_SIZE, WIRE_WIDTH,
  BODY, HEAD, LINE, DIM, SOFT, titleFont, slotFont, idFont, valueFont,
} from "./themetokens.js";

/**
 * A colour at an opacity. The hue comes from the page as `oklch(L C H)` or a
 * hex, and a canvas takes the slash form of either.
 *
 * @param {string} c
 * @param {number} a
 */
export function withAlpha(c, a) {
  if (/^(oklch|oklab|lch|lab|rgb|hsl)\(/.test(c) && !c.includes("/")) {
    return c.replace(/\)\s*$/, ` / ${a})`);
  }
  return c;
}

/** The world's own blocks wear the view's hue; every other block is grey. */
const isWorld = (/** @type {any} */ node) => node && node._irPlugin === "world";

/**
 * Text cut to a width, with an ellipsis.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} w
 */
function fit(ctx, text, w) {
  if (ctx.measureText(text).width <= w) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}\u2026`).width > w) t = t.slice(0, -1);
  return `${t}\u2026`;
}

/**
 * The block, design 10a: a dark body, a 26px head with the title in capitals
 * and the plugin id in mono at the right, a thin line round it that takes the
 * hue — and glows — when the block is selected.
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
  const { accent: P, fg: INK } = palette();
  const LiteGraph = /** @type {any} */ (globalThis).LiteGraph;
  const titleH = LiteGraph.NODE_TITLE_HEIGHT;
  const [w, h] = [size[0], size[1]];
  const world = isWorld(node);
  const missing = node._irPlaceholder || node._irMissingOn;
  ctx.save();
  if (selected) {
    ctx.shadowColor = withAlpha(P, 0.45);
    ctx.shadowBlur = 26 * (this?.ds?.scale ?? 1);
  } else {
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 24 * (this?.ds?.scale ?? 1);
    ctx.shadowOffsetY = 8 * (this?.ds?.scale ?? 1);
  }
  ctx.fillStyle = BODY;
  ctx.fillRect(0, -titleH, w, h + titleH);
  ctx.restore();
  // FL.2: a block the chosen process server does not have — or this world
  // has no plugin for — is hatched and drawn with a broken line.
  if (missing) drawHatchedRect(ctx, 0, -titleH, w, h + titleH);
  ctx.fillStyle = world ? withAlpha(P, 0.22) : HEAD;
  ctx.fillRect(0, -titleH, w, titleH);
  const line = selected || world ? P : missing ? "rgba(242, 239, 232, 0.35)" : LINE;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.setLineDash(missing && !selected ? [4, 3] : []);
  ctx.beginPath();
  ctx.moveTo(0, -0.5);
  ctx.lineTo(w, -0.5);
  ctx.stroke();
  ctx.strokeRect(0.5, -titleH + 0.5, w - 1, h + titleH - 1);
  if (selected) ctx.strokeRect(1.5, -titleH + 1.5, w - 3, h + titleH - 3);
  ctx.setLineDash([]);
  drawHead(ctx, node, w, titleH, world ? P : INK);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} node
 * @param {number} w
 * @param {number} titleH
 * @param {string} colour
 */
function drawHead(ctx, node, w, titleH, colour) {
  const title = String((node.getTitle ? node.getTitle() : node.title) ?? "").toUpperCase();
  const id = node._irPlugin && node._irNodeId ? `${node._irPlugin}/${node._irNodeId}` : "";
  ctx.textBaseline = "middle";
  ctx.font = idFont();
  const idW = id ? Math.min(ctx.measureText(id).width, w * 0.5) : 0;
  ctx.font = titleFont();
  if ("letterSpacing" in ctx) /** @type {any} */ (ctx).letterSpacing = "0.9px";
  ctx.fillStyle = colour;
  ctx.textAlign = "left";
  const room = w - TITLE_PAD_LEFT * 2 - (idW ? idW + 8 : 0);
  ctx.fillText(fit(ctx, title, room), TITLE_PAD_LEFT, -titleH * 0.5 + 1);
  if ("letterSpacing" in ctx) /** @type {any} */ (ctx).letterSpacing = "0px";
  if (id) {
    ctx.font = idFont();
    ctx.fillStyle = DIM;
    ctx.textAlign = "right";
    ctx.fillText(fit(ctx, id, idW), w - TITLE_PAD_LEFT, -titleH * 0.5 + 1);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * The hatch of design 10a: faint stripes at 135 degrees, 6px on 6px off.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function drawHatchedRect(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(242, 239, 232, 0.07)";
  ctx.lineWidth = 6 / Math.SQRT2 * 1.4;
  for (let d = -h; d < w + h; d += 12) {
    ctx.beginPath();
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
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
 * A diamond, centred on a point.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} sz
 */
function diamond(ctx, x, y, sz) {
  const r = sz * 0.72;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * What is typed onto an unwired input, as the ELX keeps it.
 *
 * @param {any} node
 * @param {string} port
 */
function constantOf(node, port) {
  const c = (node._irConstants ?? []).find((/** @type {any} */ k) => k.port === port);
  const v = c?.value?.value?.data;
  return v === undefined || v === "" ? "" : `"${v}"`;
}

/**
 * The input or output column: a diamond on the edge, the name inside, and —
 * on an input nothing is wired to — the constant it is given, in mono.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} node
 * @param {boolean} isInput
 * @param {{node:any,isInput:boolean,index:number}|null} hovered
 */
function drawSlots(ctx, node, isInput, hovered) {
  const slots = isInput ? node.inputs : node.outputs;
  if (!slots) return;
  const hue = isWorld(node) ? palette().accent : "rgba(242, 239, 232, 0.7)";
  const tmp = new Float32Array(2);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const isHovered =
      hovered && hovered.node === node && hovered.isInput === isInput && hovered.index === i;
    const pos = node.getConnectionPos(isInput, i, tmp);
    const x = pos[0] - node.pos[0];
    const y = pos[1] - node.pos[1];
    const wired = isInput ? slot.link != null : (slot.links ?? []).length > 0;
    ctx.fillStyle = wired || !isInput ? hue : "rgba(242, 239, 232, 0.3)";
    diamond(ctx, x, y, isHovered ? PORT_HOVER_SIZE : PORT_SIZE);
    const text = slot.label != null ? slot.label : slot.name;
    ctx.textBaseline = "middle";
    if (text) {
      ctx.font = slotFont();
      ctx.fillStyle = SOFT;
      ctx.textAlign = isInput ? "left" : "right";
      ctx.fillText(text, isInput ? x + 10 : x - 10, y);
    }
    const value = isInput && !wired ? constantOf(node, slot.name) : "";
    if (value && !(node.outputs && node.outputs[i])) {
      ctx.font = valueFont();
      ctx.fillStyle = "rgba(242, 239, 232, 0.6)";
      ctx.textAlign = "right";
      ctx.fillText(fit(ctx, value, node.size[0] * 0.45), node.size[0] - 10, y);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
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
  const { accent: P } = palette();
  if (link) this.visible_links.push(link);
  // Design 10a: a wire out of a World block takes the hue; the rest are ink.
  const from = link && this.graph && this.graph.getNodeById
    ? this.graph.getNodeById(link.origin_id) : null;
  const FG = isWorld(from) ? P : "rgba(242, 239, 232, 0.45)";

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
