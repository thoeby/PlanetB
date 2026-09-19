// @ts-check
// Copied from wireon-process-editor src/graph/history.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Undo / redo (Phase 22.3).
 *
 * litegraph ships no undo stack, and its `serialize`/`configure` drop the
 * `_ir*` decorations that `importFlow` stamps on every node (constants,
 * port-group state, net mapping). So instead of snapshotting litegraph's
 * view, we snapshot the **IR** — each entry is the flow's ELX text — and
 * restore by re-importing. That reuses the export→import round-trip the
 * app already guarantees (Phase 10), so an undo reconstructs the graph
 * exactly the way opening the flow does. The three change classes the
 * spec calls out all show up as ELX diffs:
 *   - net topology  → `<net>` / `<connection>` elements
 *   - port-group resize → `<port_group size="N">` + slot count
 *   - constant edits → `<constant>` elements
 *
 * The core stack is pure and dependency-injected (`serialize` / `restore`)
 * so it's unit-testable without the import pipeline. `attachHistory` binds
 * a controller to a specific graph; `markGraphDirty` is the single,
 * debounced "something changed" entry point every mutation source calls
 * (graph callbacks in `main.js`, the port-group +/- widgets, the constant
 * editor). Re-imports during a restore are guarded by `suspended` so they
 * don't record themselves.
 */

/** @type {WeakMap<any, HistoryController>} */
const controllers = new WeakMap();
/** @type {WeakSet<any>} */
const pending = new WeakSet();

/**
 * @typedef {Object} HistoryController
 * @property {(graph: any) => void} init        Capture the baseline.
 * @property {(graph: any) => void} record      Snapshot if changed.
 * @property {(graph: any) => boolean} undo
 * @property {(graph: any) => boolean} redo
 * @property {() => boolean} canUndo
 * @property {() => boolean} canRedo
 * @property {() => boolean} isSuspended
 */

/**
 * @typedef {Object} HistoryOptions
 * @property {(graph: any) => (string|null)} serialize  ELX snapshot, or
 *   null to skip recording (e.g. the graph isn't exportable right now).
 * @property {(graph: any, snap: string) => void} restore
 * @property {number} [limit]          Max undo depth (default 50).
 * @property {() => void} [onChange]   Fired after record/undo/redo.
 */

/**
 * Build a pure history controller. Holds the current snapshot plus an
 * undo and redo stack of ELX strings.
 *
 * @param {HistoryOptions} opts
 * @returns {HistoryController}
 */
export function createHistory(opts) {
  const limit = opts.limit ?? 50;
  /** @type {string[]} */
  const undoStack = [];
  /** @type {string[]} */
  const redoStack = [];
  /** @type {string|null} */
  let current = null;
  let suspended = false;

  const notify = () => { if (opts.onChange) opts.onChange(); };

  /** @param {any} graph */
  function init(graph) {
    current = opts.serialize(graph);
    undoStack.length = 0;
    redoStack.length = 0;
    notify();
  }

  /** @param {any} graph */
  function record(graph) {
    if (suspended) return;
    const snap = opts.serialize(graph);
    if (snap === null) return;            // not exportable — skip
    if (current === null) { current = snap; notify(); return; }
    if (snap === current) return;          // no structural change
    undoStack.push(current);
    if (undoStack.length > limit) undoStack.shift();
    current = snap;
    redoStack.length = 0;
    notify();
  }

  /**
   * @param {any} graph
   * @param {string} snap
   */
  function apply(graph, snap) {
    suspended = true;
    try {
      opts.restore(graph, snap);
    } finally {
      suspended = false;
    }
  }

  /** @param {any} graph */
  function undo(graph) {
    if (!undoStack.length || current === null) return false;
    redoStack.push(current);
    const snap = /** @type {string} */ (undoStack.pop());
    current = snap;
    apply(graph, snap);
    notify();
    return true;
  }

  /** @param {any} graph */
  function redo(graph) {
    if (!redoStack.length || current === null) return false;
    undoStack.push(current);
    const snap = /** @type {string} */ (redoStack.pop());
    current = snap;
    apply(graph, snap);
    notify();
    return true;
  }

  return {
    init,
    record,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    isSuspended: () => suspended,
  };
}

/**
 * Bind a controller to a graph and capture its baseline.
 *
 * @param {any} graph
 * @param {HistoryController} controller
 */
export function attachHistory(graph, controller) {
  controllers.set(graph, controller);
  controller.init(graph);
}

/**
 * @param {any} graph
 * @returns {HistoryController|null}
 */
export function getHistory(graph) {
  return graph ? controllers.get(graph) || null : null;
}

/**
 * Signal that a graph changed. Coalesces a burst of mutations (e.g.
 * deleting several selected nodes fires one callback each) into a single
 * snapshot on the next microtask. A no-op while the graph's controller is
 * mid-restore, so re-imports don't record themselves.
 *
 * @param {any} graph
 */
export function markGraphDirty(graph) {
  const c = controllers.get(graph);
  if (!c || c.isSuspended()) return;
  if (pending.has(graph)) return;
  pending.add(graph);
  Promise.resolve().then(() => {
    pending.delete(graph);
    const live = controllers.get(graph);
    if (live && !live.isSuspended()) live.record(graph);
  });
}
