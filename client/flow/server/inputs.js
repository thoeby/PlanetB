// @ts-check
// inputs.js — the `<inputs>` a job binds to its process's inputs
// (TASKS-flows.md FL.5, FL.7).
//
// buildInputsXml is copied from wireon-process-editor src/ui/run.js at
// ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: takes the flow's
// PseudoNode list (client/flow/elx/ir.js) directly. readInputsXml is its
// inverse, for a job read back from a server.

/**
 * @param {{ name: string, structure?: any }[]} inputs
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function buildInputsXml(inputs, values) {
  const doc = document.implementation.createDocument(null, "inputs", null);
  const root = doc.documentElement;
  for (const input of inputs) {
    const inEl = doc.createElement("input");
    inEl.setAttribute("name", input.name);
    const tv = input.structure;
    const structEl = doc.createElement("structure");
    structEl.setAttribute("id", (tv && tv.structure) || "droplet");
    if (tv && tv.plugin !== undefined) structEl.setAttribute("plugin", tv.plugin);
    const valEl = doc.createElement("value");
    valEl.setAttribute("id", (tv && tv.value && tv.value.id) || "string");
    if (tv && tv.value && tv.value.plugin !== undefined) {
      valEl.setAttribute("plugin", tv.value.plugin);
    }
    const data = values[input.name] != null ? String(values[input.name]) : "";
    if (data !== "") valEl.appendChild(doc.createTextNode(data));
    structEl.appendChild(valEl);
    inEl.appendChild(structEl);
    root.appendChild(inEl);
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * `{name: value}` out of an `<inputs>` blob. Tolerant: what does not parse
 * reads as nothing bound.
 *
 * @param {string} xml
 * @returns {Record<string, string>}
 */
export function readInputsXml(xml) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!xml || !xml.trim()) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) return out;
  for (const el of [...doc.getElementsByTagName("input")]) {
    const v = el.getElementsByTagName("value")[0];
    out[el.getAttribute("name") || ""] = v ? v.textContent || "" : "";
  }
  return out;
}
