// @ts-check
// Copied from wireon-process-editor src/services/params.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// typedef paths point at client/flow/plugins/parse.js (TASKS-flows.md FL.4).
/**
 * Service parameter blob (de)serialization (Phase 16).
 *
 * A configured service carries its parameters as an XML string in the
 * `parameters` field of the service payload (API-ENDPOINTS § Services).
 * The exact shape is an OPEN QUESTION; we mirror the plugin's service
 * *definition*: a flat
 *
 *   <parameters>
 *     <parameter id="connection-string"><value id="string">/tmp/db</value></parameter>
 *     <parameter id="connection-pool-size"><value id="integer">5</value></parameter>
 *   </parameters>
 *
 * The `<value>`'s `id` is the value-type carried over from the
 * definition (string / integer / boolean / a choice option's id). For
 * unknown schemas the editor skips this module entirely and round-trips
 * the raw blob as-is.
 *
 * Pure: only DOMParser, no DOM mutation outside the parsed document.
 */

/** @typedef {import("../plugins/parse.js").ServiceDef} ServiceDef */
/** @typedef {import("../plugins/parse.js").ParameterDef} ParameterDef */

/**
 * @typedef {Object} ParsedParam
 * @property {string} valueId   The `<value id="…">` type.
 * @property {string} data      The value's text content.
 */

/**
 * Serialize a `{paramId: value}` map into the `<parameters>` XML blob,
 * using the service definition to recover each value's type id. Any
 * entries in `preserve` whose id isn't part of the definition are
 * appended verbatim so a service authored elsewhere (e.g. the desktop)
 * doesn't lose parameters we don't model.
 *
 * @param {ServiceDef} def
 * @param {Object<string,string>} values
 * @param {Object<string,ParsedParam>} [preserve]
 * @returns {string}
 */
export function serializeServiceParams(def, values, preserve = {}) {
  const defIds = new Set(def.parameters.map((p) => p.id));
  let out = "<parameters>";
  for (const p of def.parameters) {
    const raw = values[p.id];
    const text = raw == null ? defaultText(p) : raw;
    const valueId = valueTypeFor(p, text);
    out += param(p.id, valueId, text);
  }
  for (const [id, v] of Object.entries(preserve)) {
    if (defIds.has(id)) continue;
    out += param(id, v.valueId, v.data);
  }
  out += "</parameters>";
  return out;
}

/**
 * Parse a `<parameters>` blob into a `{paramId: {valueId, data}}` map.
 * Tolerant of a missing `<value>` child (data becomes "").
 *
 * @param {string} xml
 * @returns {Object<string,ParsedParam>}
 */
export function parseServiceParams(xml) {
  /** @type {Object<string,ParsedParam>} */
  const out = {};
  if (!xml || !xml.trim()) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) return out;
  const root = doc.documentElement;
  if (!root) return out;
  for (const p of /** @type {HTMLCollection} */ (root.children)) {
    if (p.localName !== "parameter") continue;
    const id = p.getAttribute("id") || "";
    if (!id) continue;
    let valueId = "string";
    let data = "";
    for (const c of /** @type {HTMLCollection} */ (p.children)) {
      if (c.localName === "value") {
        valueId = c.getAttribute("id") || "string";
        data = c.textContent || "";
        break;
      }
    }
    out[id] = { valueId, data };
  }
  return out;
}

/**
 * The value-type id to emit for a parameter given its chosen text. For
 * `<value_choices>` the type comes from the matching option (falling
 * back to the first option); otherwise from the `<value>` default.
 *
 * @param {ParameterDef} p
 * @param {string} text
 * @returns {string}
 */
function valueTypeFor(p, text) {
  if (p.choices && p.choices.length) {
    const match = p.choices.find((c) => c.data === text);
    return (match || p.choices[0]).id || "string";
  }
  return (p.default && p.default.id) || "string";
}

/**
 * @param {ParameterDef} p
 * @returns {string}
 */
function defaultText(p) {
  if (p.choices && p.choices.length) {
    const byLabel = p.defaultChoiceLabel
      ? p.choices.find((c) => c.label === p.defaultChoiceLabel)
      : null;
    return (byLabel || p.choices[0]).data || "";
  }
  return (p.default && p.default.data) || "";
}

/**
 * @param {string} id
 * @param {string} valueId
 * @param {string} text
 */
function param(id, valueId, text) {
  return (
    `<parameter id="${escapeAttr(id)}">` +
    `<value id="${escapeAttr(valueId)}">${escapeText(text)}</value>` +
    `</parameter>`
  );
}

/** @param {string} s */
function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** @param {string} s */
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;");
}
