// @ts-check
// Copied from wireon-process-editor src/plugins/registry.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * In-memory registry of loaded plugins and their blocks.
 *
 * Module-level singleton, per ARCHITECTURE.md:
 *
 *   const plugins = new Map();  // pluginId -> PluginDef
 *   const blocks  = new Map();  // `${pluginId}.${blockId}` -> BlockDef
 *
 * `registerPlugin` walks the group tree once and flattens every
 * `<node>` it finds into `blocks` so `getBlock` is O(1) — ELX import
 * does a lot of lookups.
 *
 * Re-registering a plugin replaces its blocks. Unknown lookups return
 * `null`; callers decide whether to render a placeholder or error
 * (see ARCHITECTURE.md "Unknown blocks").
 */

/** @typedef {import("./parse.js").PluginDef} PluginDef */
/** @typedef {import("./parse.js").GroupDef} GroupDef */
/** @typedef {import("./parse.js").BlockDef} BlockDef */
/** @typedef {import("./parse.js").ServiceDef} ServiceDef */

/** @type {Map<string, PluginDef>} */
const plugins = new Map();

/** @type {Map<string, BlockDef>} */
const blocks = new Map();

/** @type {Map<string, ServiceDef>} pluginId.componentId -> ServiceDef */
const services = new Map();

/**
 * @param {string} pluginId
 * @param {string} blockId
 */
function key(pluginId, blockId) {
  return pluginId + "." + blockId;
}

/**
 * Reconstruct an ELX-style flat block id from a BlockDef: parent
 * groups joined by dots, then the leaf id. Examples:
 *   { groupPath: [], id: "from-string" }            -> "from-string"
 *   { groupPath: ["array"], id: "append" }          -> "array.append"
 *   { groupPath: ["path"], id: "parent-path" }      -> "path.parent-path"
 *
 * @param {BlockDef} b
 */
function elxId(b) {
  return b.groupPath.length ? b.groupPath.join(".") + "." + b.id : b.id;
}

/**
 * Register a plugin and index all of its blocks (including those
 * nested in groups). If the plugin id is already registered, its old
 * blocks are evicted first so the registry doesn't accumulate stale
 * entries on hot-reload.
 *
 * @param {PluginDef} def
 */
export function registerPlugin(def) {
  const existing = plugins.get(def.id);
  if (existing) {
    for (const b of flattenBlocks(existing)) blocks.delete(key(def.id, elxId(b)));
    for (const s of existing.services || []) services.delete(key(def.id, s.id));
  }
  plugins.set(def.id, def);
  for (const b of flattenBlocks(def)) blocks.set(key(def.id, elxId(b)), b);
  for (const s of def.services || []) services.set(key(def.id, s.id), s);
}

/**
 * Look up a block by `(pluginId, elxId)`. `elxId` is the ELX flat
 * form — group path joined by dots, then leaf id, e.g.
 * `"directory.entries"`. Returns `null` when not found.
 *
 * @param {string} pluginId
 * @param {string} elxId
 * @returns {BlockDef|null}
 */
export function getBlock(pluginId, elxId) {
  return blocks.get(key(pluginId, elxId)) || null;
}

/**
 * @returns {BlockDef[]}
 */
export function allBlocks() {
  return [...blocks.values()];
}

/**
 * @returns {PluginDef[]}
 */
export function allPlugins() {
  return [...plugins.values()];
}

/**
 * Look up a service type by `(pluginId, componentId)`, e.g.
 * `("sql", "database")`. Returns `null` when not found.
 *
 * @param {string} pluginId
 * @param {string} componentId
 * @returns {ServiceDef|null}
 */
export function getService(pluginId, componentId) {
  return services.get(key(pluginId, componentId)) || null;
}

/**
 * Every registered service type across all plugins, in registration
 * order. Used to populate the "service type" dropdown in the editor.
 *
 * @returns {ServiceDef[]}
 */
export function allServices() {
  return [...services.values()];
}

/**
 * Group all registered blocks by their palette path
 * `<pluginId>[/<groupId>]*`. Useful for rendering the block palette
 * panel in Phase 5.
 *
 * @returns {Map<string, BlockDef[]>}
 */
export function byGroup() {
  /** @type {Map<string, BlockDef[]>} */
  const out = new Map();
  for (const b of blocks.values()) {
    const path = [b.plugin, ...b.groupPath].join("/");
    const bucket = out.get(path);
    if (bucket) bucket.push(b);
    else out.set(path, [b]);
  }
  return out;
}

/**
 * Drop every registered plugin. Intended for tests; production code
 * shouldn't need this.
 */
export function clear() {
  plugins.clear();
  blocks.clear();
  services.clear();
}

/**
 * Walk a plugin's group tree and yield every block, preserving
 * source order (top-level blocks first, then groups in declared
 * order, recursing depth-first).
 *
 * @param {PluginDef} def
 * @returns {BlockDef[]}
 */
function flattenBlocks(def) {
  /** @type {BlockDef[]} */
  const out = [];
  for (const b of def.blocks) out.push(b);
  for (const g of def.groups) collectFromGroup(g, out);
  return out;
}

/**
 * @param {GroupDef} group
 * @param {BlockDef[]} out
 */
function collectFromGroup(group, out) {
  for (const b of group.blocks) out.push(b);
  for (const g of group.groups) collectFromGroup(g, out);
}
