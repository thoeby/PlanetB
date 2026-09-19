// @ts-check
// Copied from wireon-process-editor src/plugins/parse.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * Plugin XML parser: plugin.xml text -> PluginDef.
 *
 * Pure conversion: only uses DOMParser. No network, no DOM mutation
 * outside the parsed document, no litegraph imports.
 *
 * What a plugin XML looks like (see docs/blocks/<id>/plugin.xml):
 *
 *   <plugin format="1" id="json">
 *     <name>JSON</name>
 *     <icon type="simicons">file::json</icon>
 *     <node id="...">...</node>
 *     <group id="array">
 *       <name>Array</name>
 *       <node id="append">...</node>
 *       ...
 *     </group>
 *   </plugin>
 *
 * <group> elements nest arbitrarily and carry their own <name>/<icon>.
 * <node> elements describe a single BlockDef and may carry <parameter>,
 * <input>, <output>, <description type="short|long">, <icon>, <name>.
 *
 * The shape exported here is consumed by `src/plugins/registry.js`
 * (Phase 4) and `src/graph/register.js` (Phase 5).
 */

/**
 * @typedef {Object} PluginDef
 * @property {string} id
 * @property {string} name
 * @property {string} [format]
 * @property {string} [icon]
 * @property {string} [iconType]
 * @property {BlockDef[]} blocks         Top-level (un-grouped) blocks.
 * @property {GroupDef[]} groups         Top-level groups (may nest).
 * @property {ServiceDef[]} services     Service types this plugin provides.
 */

/**
 * A configurable service type declared by a plugin (top-level
 * `<service id="…">` with a `<name>` and `<parameter>` children, e.g.
 * `sql::database`, `http::server`). Distinct from the `<service
 * plugin="…" id="…"/>` *reference* a `<node>` carries to bind to a
 * service instance — those live inside nodes and are not parsed here.
 *
 * @typedef {Object} ServiceDef
 * @property {string} id                  Component id (e.g. "database").
 * @property {string} plugin              Providing plugin id.
 * @property {string} [name]
 * @property {Object<string,string>} descriptions
 * @property {ParameterDef[]} parameters
 */

/**
 * @typedef {Object} GroupDef
 * @property {string} id
 * @property {string} [name]
 * @property {string} [icon]
 * @property {string} [iconType]
 * @property {BlockDef[]} blocks
 * @property {GroupDef[]} groups
 */

/**
 * @typedef {Object} BlockDef
 * @property {string} id
 * @property {string} plugin              Plugin id, copied for convenience.
 * @property {string[]} groupPath         Ancestor group ids; [] for root.
 * @property {string} name
 * @property {string} [icon]
 * @property {string} [iconType]
 * @property {Object<string,string>} descriptions   Keyed by `type` attr.
 * @property {ParameterDef[]} parameters
 * @property {PortDef[]} inputs
 * @property {PortDef[]} outputs
 */

/**
 * @typedef {Object} ParameterDef
 * @property {string} id
 * @property {string} [name]
 * @property {Object<string,string>} descriptions
 * @property {ValueDef} [default]         The widget's default value.
 * @property {ChoiceDef[]} [choices]      Options from `<value_choices>`,
 *   when the parameter is an enumerated dropdown rather than a free field.
 * @property {string} [defaultChoiceLabel]  `default-label` on `<value_choices>`.
 */

/**
 * One option of a `<value_choices>` dropdown. `id` is the value-type
 * (e.g. "string"), `data` the stored value, `label` the display text.
 *
 * @typedef {Object} ChoiceDef
 * @property {string} id
 * @property {string} [label]
 * @property {string} [data]
 */

/**
 * Describes one declared port (`<input>` or `<output>` in plugin XML).
 *
 * `structures` and `values` are lists because plugin XML uses repetition
 * to declare union acceptance — e.g. an input that accepts either a
 * `string` or a `filesystem path` lists both `<value>` children. See
 * OPEN-QUESTIONS.md Q3 for the connection-validation policy.
 *
 * @typedef {Object} PortDef
 * @property {string} name
 * @property {string} [type]              Raw `type` attr (e.g. "group").
 * @property {number} [min]               Min arity for `type="group"` ports.
 * @property {boolean} [repeatable]       True iff type === "group". Q1 default.
 * @property {string} [constant]          Raw text of `<constant>…</constant>`.
 * @property {StructureDef[]} structures
 * @property {ValueDef[]} values
 */

/**
 * @typedef {Object} StructureDef
 * @property {string} id
 * @property {string} [plugin]
 * @property {string} [defaultAttr]       The `default="…"` attribute, raw.
 * @property {ValueDef} [value]           Inline baked-in default (see fs.write).
 */

/**
 * @typedef {Object} ValueDef
 * @property {string} id
 * @property {string} [plugin]
 * @property {string} [data]              Raw text content if present.
 */

/**
 * Parse a plugin XML document into a PluginDef.
 *
 * @param {string} xmlText
 * @returns {PluginDef}
 */
export function parsePlugin(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  const errEl = doc.getElementsByTagName("parsererror")[0];
  if (errEl) {
    throw new Error("Plugin XML parse error: " + (errEl.textContent || "").trim());
  }

  const root = doc.documentElement;
  if (!root || root.localName !== "plugin") {
    throw new Error(
      "Expected root <plugin>, got <" + (root ? root.localName : "null") + ">"
    );
  }

  const id = root.getAttribute("id") || "";
  /** @type {PluginDef} */
  const plugin = {
    id,
    name: childText(root, "name"),
    blocks: childrenEls(root, "node").map((el) => parseBlock(el, id, [])),
    groups: childrenEls(root, "group").map((el) => parseGroup(el, id, [])),
    services: childrenEls(root, "service").map((el) => parseService(el, id)),
  };
  if (root.hasAttribute("format")) plugin.format = root.getAttribute("format") || "";

  const iconEl = childEl(root, "icon");
  if (iconEl) {
    plugin.icon = (iconEl.textContent || "").trim();
    if (iconEl.hasAttribute("type")) plugin.iconType = iconEl.getAttribute("type") || "";
  }
  return plugin;
}

/**
 * @param {Element} el
 * @param {string} pluginId
 * @param {string[]} parentPath
 * @returns {GroupDef}
 */
function parseGroup(el, pluginId, parentPath) {
  const id = el.getAttribute("id") || "";
  const path = [...parentPath, id];
  /** @type {GroupDef} */
  const group = {
    id,
    blocks: childrenEls(el, "node").map((nodeEl) => parseBlock(nodeEl, pluginId, path)),
    groups: childrenEls(el, "group").map((g) => parseGroup(g, pluginId, path)),
  };
  const nameEl = childEl(el, "name");
  if (nameEl) group.name = (nameEl.textContent || "").trim();

  const iconEl = childEl(el, "icon");
  if (iconEl) {
    group.icon = (iconEl.textContent || "").trim();
    if (iconEl.hasAttribute("type")) group.iconType = iconEl.getAttribute("type") || "";
  }
  return group;
}

/**
 * @param {Element} el
 * @param {string} pluginId
 * @param {string[]} groupPath
 * @returns {BlockDef}
 */
function parseBlock(el, pluginId, groupPath) {
  /** @type {BlockDef} */
  const block = {
    id: el.getAttribute("id") || "",
    plugin: pluginId,
    groupPath: [...groupPath],
    name: childText(el, "name"),
    descriptions: collectDescriptions(el),
    parameters: childrenEls(el, "parameter").map(parseParameter),
    inputs: childrenEls(el, "input").map(parsePort),
    outputs: childrenEls(el, "output").map(parsePort),
  };
  const iconEl = childEl(el, "icon");
  if (iconEl) {
    block.icon = (iconEl.textContent || "").trim();
    if (iconEl.hasAttribute("type")) block.iconType = iconEl.getAttribute("type") || "";
  }
  return block;
}

/**
 * Parse a top-level `<service>` definition into a ServiceDef. Shares the
 * `<parameter>` parser with blocks so the editor can render service
 * parameter widgets the same way (TASKS-V1.md § 16.2).
 *
 * @param {Element} el
 * @param {string} pluginId
 * @returns {ServiceDef}
 */
function parseService(el, pluginId) {
  /** @type {ServiceDef} */
  const service = {
    id: el.getAttribute("id") || "",
    plugin: pluginId,
    descriptions: collectDescriptions(el),
    parameters: childrenEls(el, "parameter").map(parseParameter),
  };
  const nameEl = childEl(el, "name");
  if (nameEl) service.name = (nameEl.textContent || "").trim();
  return service;
}

/**
 * @param {Element} el
 * @returns {ParameterDef}
 */
function parseParameter(el) {
  /** @type {ParameterDef} */
  const param = {
    id: el.getAttribute("id") || "",
    descriptions: collectDescriptions(el),
  };
  const nameEl = childEl(el, "name");
  if (nameEl) param.name = (nameEl.textContent || "").trim();
  const valEl = childEl(el, "value");
  if (valEl) param.default = parseValueDef(valEl);
  const choicesEl = childEl(el, "value_choices");
  if (choicesEl) {
    param.choices = childrenEls(choicesEl, "value").map(parseChoiceDef);
    if (choicesEl.hasAttribute("default-label")) {
      param.defaultChoiceLabel = choicesEl.getAttribute("default-label") || "";
    }
  }
  return param;
}

/**
 * @param {Element} el
 * @returns {ChoiceDef}
 */
function parseChoiceDef(el) {
  /** @type {ChoiceDef} */
  const c = { id: el.getAttribute("id") || "" };
  if (el.hasAttribute("label")) c.label = el.getAttribute("label") || "";
  const text = el.textContent || "";
  if (text.length > 0) c.data = text;
  return c;
}

/**
 * @param {Element} el
 * @returns {PortDef}
 */
function parsePort(el) {
  /** @type {PortDef} */
  const port = {
    name: el.getAttribute("name") || "",
    structures: childrenEls(el, "structure").map(parseStructureDef),
    values: childrenEls(el, "value").map(parseValueDef),
  };
  if (el.hasAttribute("type")) {
    port.type = el.getAttribute("type") || "";
    if (port.type === "group") port.repeatable = true;
  }
  if (el.hasAttribute("min")) {
    const m = Number.parseInt(el.getAttribute("min") || "", 10);
    if (!Number.isNaN(m)) port.min = m;
  }
  const constEl = childEl(el, "constant");
  if (constEl) port.constant = (constEl.textContent || "").trim();
  return port;
}

/**
 * @param {Element} el
 * @returns {StructureDef}
 */
function parseStructureDef(el) {
  /** @type {StructureDef} */
  const s = { id: el.getAttribute("id") || "" };
  if (el.hasAttribute("plugin")) s.plugin = el.getAttribute("plugin") || "";
  if (el.hasAttribute("default")) s.defaultAttr = el.getAttribute("default") || "";
  const valEl = childEl(el, "value");
  if (valEl) s.value = parseValueDef(valEl);
  return s;
}

/**
 * @param {Element} el
 * @returns {ValueDef}
 */
function parseValueDef(el) {
  /** @type {ValueDef} */
  const v = { id: el.getAttribute("id") || "" };
  if (el.hasAttribute("plugin")) v.plugin = el.getAttribute("plugin") || "";
  const text = el.textContent || "";
  if (text.length > 0) v.data = text;
  return v;
}

/**
 * Collect <description type="…"> children into a map keyed by `type`.
 * Missing `type` attribute degrades to key `""`.
 *
 * @param {Element} el
 * @returns {Object<string,string>}
 */
function collectDescriptions(el) {
  /** @type {Object<string,string>} */
  const out = {};
  for (const d of childrenEls(el, "description")) {
    const key = d.getAttribute("type") || "";
    out[key] = (d.textContent || "").trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element|null}
 */
function childEl(parent, localName) {
  for (const c of /** @type {HTMLCollection} */ (parent.children)) {
    if (c.localName === localName) return c;
  }
  return null;
}

/**
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenEls(parent, localName) {
  const out = [];
  for (const c of /** @type {HTMLCollection} */ (parent.children)) {
    if (c.localName === localName) out.push(c);
  }
  return out;
}

/**
 * @param {Element} parent
 * @param {string} localName
 * @returns {string}
 */
function childText(parent, localName) {
  const el = childEl(parent, localName);
  return el ? (el.textContent || "").trim() : "";
}
