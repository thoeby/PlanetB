// @ts-check
// Copied from wireon-process-editor src/graph/subflow.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Subflow integration: <filter> and <transformation> become nodes
 * whose body is a nested litegraph LGraph. Litegraph already has the
 * machinery for nested graphs — a node with a `.subgraph` property
 * gets the built-in stack-based navigation (`openSubgraph` /
 * `closeSubgraph`) and the `subgraph_button` hit area on the title
 * bar. We piggyback on that and only fill in the pieces it doesn't:
 *
 *   - outer-facing slots derived from the inner body's pseudo-nodes
 *     (the documented filter/transformation contract — see
 *     docs/ELX-FORMAT.md);
 *   - recursive `importFlow` of the body into the inner graph so the
 *     subflow renders identically on its own canvas;
 *   - a Wireon-themed breadcrumb on top of the canvas so users have
 *     a visible "back to parent" affordance.
 *
 * The recursive call into `importFlow` is taken via a callback rather
 * than a direct import to avoid an import cycle (`import.js` calls
 * `createSubflowNode` while we'd be calling back into `importFlow`).
 */

/** @typedef {import("../elx/ir.js").SubflowInstance} SubflowInstance */
/** @typedef {import("../elx/nets.js").GetBlock} GetBlock */
/** @typedef {(flow: any, getBlock: GetBlock, LiteGraph: any, graph: any, scopePath?: string, flowHash?: string) => any} ImportFlowFn */

/**
 * Build a litegraph node that represents a subflow. Outer slots come
 * from the body's `<input>` / `<output>` pseudo-nodes; the inner
 * subgraph is populated by recursing into `importFlow` so the body
 * renders identically when navigated into.
 *
 * @param {SubflowInstance} s
 * @param {GetBlock} getBlock
 * @param {any} LiteGraph
 * @param {ImportFlowFn} importFlow
 * @param {string} [scopePath]
 * @param {string} [flowHash]
 */
export function createSubflowNode(s, getBlock, LiteGraph, importFlow, scopePath = "", flowHash = "") {
  const node = new LiteGraph.LGraphNode(s.name);
  node._irName = s.name;
  node._irKind = "subflow";
  node._irSubflowKind = s.kind;
  node._irSubflowId = s.id;
  node._irSubflowType = s.type;
  if (s.plugin !== undefined) node._irSubflowPlugin = s.plugin;
  node._irSubflowBody = s.body;

  // Outer slot contract. The body's pseudo-inputs/outputs name them
  // (e.g. "list [in]", "droplet [in]", "index" for filter and
  // transformation alike). Slot type is "*" because typed information
  // about the connecting structure depends on the caller; the
  // structure-aware check lives on the *block* slots elsewhere.
  for (const p of s.body.inputs) node.addInput(p.name, "*");
  for (const p of s.body.outputs) node.addOutput(p.name, "*");

  // Inner graph (the subgraph). Setting `node.subgraph` activates
  // litegraph's built-in subgraph navigation (`openSubgraph`,
  // `_graph_stack`, drawSubgraphPanel) for free.
  const inner = new LiteGraph.LGraph();
  inner._subgraph_node = node;
  inner._is_subgraph = true;
  node.subgraph = inner;
  // We render our own breadcrumb (see attachSubgraphChrome) so the
  // default in-title-bar click area would be misleading. Disable it.
  node.skip_subgraph_button = true;

  const childScope = scopePath ? `${scopePath}/${s.name}` : s.name;
  importFlow(s.body, getBlock, LiteGraph, inner, childScope, flowHash);

  // Double-click opens the subgraph. setTimeout matches litegraph's
  // built-in Subgraph node so the click event finishes propagating
  // before the canvas reattaches.
  node.onDblClick = function (/** @type {any} */ _e, /** @type {any} */ _pos, /** @type {any} */ graphcanvas) {
    setTimeout(() => graphcanvas.openSubgraph(inner), 10);
  };

  return node;
}

/**
 * Install Wireon-themed subgraph chrome on the given canvas:
 *
 *   - replace the built-in dark `drawSubgraphPanel` with a no-op so
 *     it doesn't paint over our canvas;
 *   - wrap `openSubgraph` / `closeSubgraph` to update a DOM breadcrumb
 *     anchored to the canvas wrapper.
 *
 * Idempotent: safe to call once per session from main.js.
 *
 * @param {any} graphCanvas        Instance of LGraphCanvas.
 * @param {HTMLElement} container  Element wrapping the canvas; the
 *                                 breadcrumb is appended here.
 */
export function attachSubgraphChrome(graphCanvas, container) {
  const g = /** @type {any} */ (globalThis);
  const LGraphCanvas = g.LGraphCanvas;
  if (!LGraphCanvas) return;

  // Silence the default dark panel. Nothing on this canvas should be
  // gray-on-rounded-corners.
  LGraphCanvas.prototype.drawSubgraphPanel = function () { /* no-op */ };

  // Breadcrumb DOM. Hidden when the stack is empty (top-level flow).
  let bar = /** @type {HTMLElement|null} */ (container.querySelector(".subgraph-breadcrumb"));
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "subgraph-breadcrumb";
    bar.hidden = true;
    container.appendChild(bar);
  }

  /** @param {any} canvas */
  const refresh = (canvas) => updateBreadcrumb(bar, canvas);

  // Wrap navigation methods so the breadcrumb always reflects the
  // current stack. We patch the prototype but each canvas instance
  // shares it — the wrappers read `this.graph`, so they work for any
  // canvas that gets navigated.
  if (!LGraphCanvas.prototype._wireonSubgraphPatched) {
    const origOpen = LGraphCanvas.prototype.openSubgraph;
    const origClose = LGraphCanvas.prototype.closeSubgraph;
    LGraphCanvas.prototype.openSubgraph = function (/** @type {any} */ graph) {
      const r = origOpen.call(this, graph);
      refresh(this);
      return r;
    };
    LGraphCanvas.prototype.closeSubgraph = function () {
      const r = origClose.call(this);
      refresh(this);
      return r;
    };
    LGraphCanvas.prototype._wireonSubgraphPatched = true;
  }
  refresh(graphCanvas);
}

/**
 * Re-render the breadcrumb DOM for the canvas's current graph stack.
 *
 * @param {HTMLElement} bar
 * @param {any} canvas
 */
function updateBreadcrumb(bar, canvas) {
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  const stack = canvas._graph_stack || [];
  if (!stack.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  // Crumb 0 is the root, then each pushed graph, then the active one.
  const crumbs = [];
  crumbs.push(crumbLabel(stack[0], "Flow"));
  for (let i = 1; i < stack.length; i++) crumbs.push(crumbLabel(stack[i]));
  crumbs.push(crumbLabel(canvas.graph));

  // "Back" button closes one level at a time; the breadcrumb itself
  // is informational only (no per-crumb jump for v1 — fewer footguns
  // and only one level is common in practice).
  const back = document.createElement("button");
  back.type = "button";
  back.className = "subgraph-back";
  back.textContent = "← Back";
  back.addEventListener("click", () => canvas.closeSubgraph());
  bar.appendChild(back);

  for (let i = 0; i < crumbs.length; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "subgraph-sep";
      sep.textContent = "/";
      bar.appendChild(sep);
    }
    const span = document.createElement("span");
    span.className = i === crumbs.length - 1 ? "subgraph-crumb current" : "subgraph-crumb";
    span.textContent = crumbs[i];
    bar.appendChild(span);
  }
}

/**
 * @param {any} graph
 * @param {string} [fallback]
 */
function crumbLabel(graph, fallback) {
  const node = graph && graph._subgraph_node;
  if (node && node._irName) return String(node._irName);
  if (node && node.title) return String(node.title);
  return fallback || "subgraph";
}
