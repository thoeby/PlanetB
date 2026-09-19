// @ts-check
// Copied from wireon-process-editor src/layout-store/sidecar.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b;
// changes: the backing store is not localStorage but `flow.layout` in the
// world — a plain object this module holds and the Flows app reads back and
// saves with the flow (save path: serialize ELX -> sha256 -> register -> save_flow).
// Layout is still never written into the ELX, which is the whole point of the
// original file; only where it is kept has moved from one browser to the world,
// so that a flow reopened on another machine looks the same. Renamed from
// sidecar.js to layoutstore.js because it is no longer a sidecar file.
/**
 * Per-flow layout overrides (Phase 9).
 *
 * Layout coordinates are sidecar-only — never written into ELX. We
 * keep them in `flow.layout` in the world, keyed by a stable hash of
 * the ELX content (so the same flow recovers its layout even if the
 * file is renamed) and the scope path (so subflow bodies don't shadow
 * the parent's positions).
 *
 *   key: `elx-layout::${flowHash}::${scopePath}`
 *   val: JSON `{ [nodeName]: { x, y } }`
 *
 * Reads merge all scope positions into a single Map. Writes do a
 * read-modify-write of the per-scope JSON. The data set is small
 * (dozens of entries) so this is fine.
 */

import { serializeElx } from "../elx/serialize.js";

/** @typedef {import("../elx/ir.js").Flow} Flow */

const KEY_PREFIX = "elx-layout::";

/**
 * Hidden-output overrides live in a parallel namespace to layout (Phase
 * 18.3). Output visibility is editor state, not part of the flow, so —
 * like coordinates — it is sidecar-only and never written to ELX. Keyed
 * the same way (flow hash + scope) so subflow bodies keep their own set.
 *
 *   key: `elx-hidden::${flowHash}::${scopePath}`
 *   val: JSON `{ [nodeName]: string[] }`  (hidden output port names)
 */
const HIDDEN_PREFIX = "elx-hidden::";

/**
 * FNV-1a, 32-bit. Stable, dependency-free. The hash is a fingerprint
 * of structure-affecting bytes; layout coordinates aren't included
 * because they never appear in ELX.
 *
 * @param {string} text
 * @returns {string}   Eight-character lowercase hex.
 */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // Mul by FNV prime 16777619, kept inside 32 bits.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash a flow by serializing it and feeding the canonical XML through
 * FNV-1a. Whitespace/attribute order is already normalised by our
 * serializer, so the hash is stable across import → export round-trips.
 *
 * @param {Flow} flow
 * @returns {string}
 */
export function flowHash(flow) {
  return fnv1a(serializeElx(flow));
}

/**
 * Read all saved overrides for one scope of one flow.
 *
 * @param {string} flowHash
 * @param {string} scopePath
 * @returns {Map<string, { x: number, y: number }>}
 */
export function loadOverrides(flowHash, scopePath) {
  /** @type {Map<string, { x: number, y: number }>} */
  const out = new Map();
  if (!flowHash) return out;
  const raw = safeGetItem(key(flowHash, scopePath));
  if (!raw) return out;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return out; }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [name, pos] of Object.entries(parsed)) {
    const p = /** @type {any} */ (pos);
    if (p && typeof p.x === "number" && typeof p.y === "number") {
      out.set(name, { x: p.x, y: p.y });
    }
  }
  return out;
}

/**
 * Persist one node's coordinates. Read-modify-write the per-scope JSON.
 *
 * @param {string} flowHash
 * @param {string} scopePath
 * @param {string} nodeName
 * @param {{ x: number, y: number }} pos
 */
export function saveNodePosition(flowHash, scopePath, nodeName, pos) {
  if (!flowHash) return;
  const k = key(flowHash, scopePath);
  const raw = safeGetItem(k);
  /** @type {Record<string, { x: number, y: number }>} */
  let bag = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") bag = parsed;
    } catch { /* corrupted entry — overwrite */ }
  }
  bag[nodeName] = { x: pos.x, y: pos.y };
  safeSetItem(k, JSON.stringify(bag));
}

/**
 * Drop all saved coordinates for one (flowHash, scopePath) bucket.
 * Test-only escape hatch.
 *
 * @param {string} flowHash
 * @param {string} scopePath
 */
export function clearScope(flowHash, scopePath) {
  if (!flowHash) return;
  safeRemoveItem(key(flowHash, scopePath));
}

/**
 * Read all hidden-output sets for one scope of one flow.
 *
 * @param {string} flowHash
 * @param {string} scopePath
 * @returns {Map<string, Set<string>>}   nodeName -> set of hidden ports
 */
export function loadHiddenOutputs(flowHash, scopePath) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  if (!flowHash) return out;
  const raw = safeGetItem(hiddenKey(flowHash, scopePath));
  if (!raw) return out;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return out; }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [name, list] of Object.entries(parsed)) {
    if (Array.isArray(list)) out.set(name, new Set(list.filter((s) => typeof s === "string")));
  }
  return out;
}

/**
 * Persist one node's hidden-output set. An empty set drops the entry so
 * the store doesn't accumulate noise.
 *
 * @param {string} flowHash
 * @param {string} scopePath
 * @param {string} nodeName
 * @param {string[]} hiddenPorts
 */
export function saveHiddenOutputs(flowHash, scopePath, nodeName, hiddenPorts) {
  if (!flowHash) return;
  const k = hiddenKey(flowHash, scopePath);
  const raw = safeGetItem(k);
  /** @type {Record<string, string[]>} */
  let bag = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") bag = parsed;
    } catch { /* corrupted entry — overwrite */ }
  }
  if (hiddenPorts.length) bag[nodeName] = hiddenPorts;
  else delete bag[nodeName];
  safeSetItem(k, JSON.stringify(bag));
}

/**
 * Wrap an LGraphCanvas so that whenever a node is dragged its new
 * position is written back to the layout store. We hook
 * `processMouseUp` (litegraph's drag-end) rather than per-frame
 * `node_dragged` for two reasons: a single write per drag-stroke and
 * no chance of saving an intermediate position that the user is about
 * to undo by releasing outside the canvas.
 *
 * Reads `node._irFlowHash` / `node._irScopePath` / `node._irName`
 * which `importFlow` stamps on every node it creates.
 *
 * Idempotent: hooking the same canvas twice is a no-op.
 *
 * @param {any} graphCanvas
 */
export function watchDragsForLayout(graphCanvas) {
  if (!graphCanvas || graphCanvas._wireonDragWatched) return;
  graphCanvas._wireonDragWatched = true;
  const orig = graphCanvas.processMouseUp ? graphCanvas.processMouseUp.bind(graphCanvas) : null;

  graphCanvas.processMouseUp = function (/** @type {any} */ e) {
    const dragged = collectDragged(graphCanvas);
    const r = orig ? orig(e) : undefined;
    for (const node of dragged) {
      if (!node || !node._irName || !node._irFlowHash) continue;
      const pos = node.pos;
      if (!Array.isArray(pos) || pos.length < 2) continue;
      saveNodePosition(
        node._irFlowHash,
        node._irScopePath || "",
        node._irName,
        { x: pos[0], y: pos[1] },
      );
    }
    return r;
  };
}

/**
 * Best-effort: snapshot every node that's currently selected (and
 * therefore part of the in-progress drag). Litegraph doesn't fire a
 * "drag end" event with the involved nodes, so we approximate by
 * reading `selected_nodes`.
 *
 * @param {any} graphCanvas
 * @returns {any[]}
 */
function collectDragged(graphCanvas) {
  const sel = graphCanvas.selected_nodes;
  if (!sel) return graphCanvas.node_dragged ? [graphCanvas.node_dragged] : [];
  return Object.values(sel);
}

/**
 * @param {string} flowHash
 * @param {string} scopePath
 */
function key(flowHash, scopePath) {
  return `${KEY_PREFIX}${flowHash}::${scopePath}`;
}

/**
 * @param {string} flowHash
 * @param {string} scopePath
 */
function hiddenKey(flowHash, scopePath) {
  return `${HIDDEN_PREFIX}${flowHash}::${scopePath}`;
}

/**
 * The bag the three accessors below read and write: exactly the JSON that
 * `flow.layout` holds in the world, one entry per storage key.
 *
 * @type {Record<string, string>}
 */
let bag = {};

/** @type {(layout: Record<string, string>) => void} */
let onChange = () => {};

/**
 * Install the layout of the flow that is being opened, and say where changes
 * to it should go. The Flows app passes `flow.layout` straight in and marks
 * itself dirty from `changed`.
 *
 * @param {Record<string, string> | null | undefined} layout
 * @param {(layout: Record<string, string>) => void} [changed]
 */
export function setLayout(layout, changed) {
  bag = layout && typeof layout === "object" ? { ...layout } : {};
  onChange = changed || (() => {});
}

/**
 * The layout as it stands, to be saved with the flow.
 *
 * @returns {Record<string, string>}
 */
export function getLayout() {
  return { ...bag };
}

/** @param {string} k */
function safeGetItem(k) {
  return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null;
}
/** @param {string} k @param {string} v */
function safeSetItem(k, v) {
  if (bag[k] === v) return;
  bag[k] = v;
  onChange(getLayout());
}
/** @param {string} k */
function safeRemoveItem(k) {
  if (!Object.prototype.hasOwnProperty.call(bag, k)) return;
  delete bag[k];
  onChange(getLayout());
}
