// @ts-check
// Copied from wireon-process-editor src/elx/parse.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * ELX flow parser: XML text -> Flow IR.
 *
 * Pure conversion: only uses DOMParser. No DOM mutations, no litegraph,
 * no fetch. The caller is responsible for fetching the XML text.
 *
 * Design notes:
 *   - Element order within each child-bucket (nodes, nets, subflows,
 *     pseudo-inputs/outputs) is preserved as it appeared in the source.
 *   - CDATA inside <value> is captured via the `cdata` flag on
 *     ValueLiteral so the serializer can re-emit it the same way.
 *   - Unknown attributes/children on <node> are preserved in an `extras`
 *     bag so they round-trip verbatim. See CLAUDE.md round-trip rule.
 */

/** @typedef {import("./ir.js").Flow} Flow */
/** @typedef {import("./ir.js").EngineConfig} EngineConfig */
/** @typedef {import("./ir.js").PseudoNode} PseudoNode */
/** @typedef {import("./ir.js").NodeInstance} NodeInstance */
/** @typedef {import("./ir.js").SubflowInstance} SubflowInstance */
/** @typedef {import("./ir.js").PortConstant} PortConstant */
/** @typedef {import("./ir.js").PortGroup} PortGroup */
/** @typedef {import("./ir.js").ParameterOverride} ParameterOverride */
/** @typedef {import("./ir.js").TypedValue} TypedValue */
/** @typedef {import("./ir.js").ValueLiteral} ValueLiteral */
/** @typedef {import("./ir.js").Net} Net */
/** @typedef {import("./ir.js").NetConnection} NetConnection */
/** @typedef {import("./ir.js").Extras} Extras */

const NODE_KNOWN_ATTRS = new Set(["id", "name", "plugin"]);
const NODE_KNOWN_CHILDREN = new Set(["parameter", "constant", "port_group"]);

/**
 * Parse an ELX export into the Flow IR.
 *
 * @param {string} xmlText
 * @returns {Flow}
 */
export function parseElx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  // DOMParser reports XML errors inline as a <parsererror> element rather
  // than throwing. Surface it as a real exception.
  const errEl = doc.getElementsByTagName("parsererror")[0];
  if (errEl) {
    throw new Error("ELX parse error: " + (errEl.textContent || "").trim());
  }

  const root = doc.documentElement;
  if (!root || root.localName !== "elx") {
    throw new Error(
      "Expected root element <elx>, got <" + (root ? root.localName : "null") + ">"
    );
  }
  return parseFlow(root);
}

/**
 * @param {Element} elx
 * @returns {Flow}
 */
function parseFlow(elx) {
  const engineEl = childEl(elx, "engine");
  if (!engineEl) throw new Error("Missing <engine> in <elx>");

  return {
    engine: parseEngine(engineEl),
    inputs: childrenEls(elx, "input").map((el) => parsePseudoNode(el, "input")),
    outputs: childrenEls(elx, "output").map((el) => parsePseudoNode(el, "output")),
    nodes: childrenEls(elx, "node").map(parseNodeInstance),
    subflows: [
      ...childrenEls(elx, "filter").map((el) => parseSubflow(el, "filter")),
      ...childrenEls(elx, "transformation").map((el) => parseSubflow(el, "transformation")),
    ],
    nets: childrenEls(elx, "net").map(parseNet),
  };
}

/**
 * @param {Element} el
 * @returns {EngineConfig}
 */
function parseEngine(el) {
  const maxStepsText = childEl(el, "max_steps")?.textContent ?? "0";
  const recordText = (childEl(el, "record_history")?.textContent ?? "false").trim();
  return {
    type: el.getAttribute("type") || "",
    maxSteps: Number.parseInt(maxStepsText, 10),
    recordHistory: recordText === "true",
  };
}

/**
 * @param {Element} el
 * @param {"input"|"output"} kind
 * @returns {PseudoNode}
 */
function parsePseudoNode(el, kind) {
  /** @type {PseudoNode} */
  const node = { kind, name: el.getAttribute("name") || "" };
  const structEl = childEl(el, "structure");
  if (structEl) node.structure = parseTypedValue(structEl);
  return node;
}

/**
 * @param {Element} el
 * @returns {NodeInstance}
 */
function parseNodeInstance(el) {
  /** @type {NodeInstance} */
  const node = {
    id: el.getAttribute("id") || "",
    plugin: el.getAttribute("plugin") || "",
    name: el.getAttribute("name") || "",
    parameters: childrenEls(el, "parameter").map(parseParameter),
    constants: childrenEls(el, "constant").map(parseConstant),
    portGroups: childrenEls(el, "port_group").map(parsePortGroup),
  };
  const extras = collectExtras(el, NODE_KNOWN_ATTRS, NODE_KNOWN_CHILDREN);
  if (extras) node.extras = extras;
  return node;
}

/**
 * @param {Element} el
 * @returns {ParameterOverride}
 */
function parseParameter(el) {
  const valEl = childEl(el, "value");
  if (!valEl) {
    // No <value> child: synthesize an empty literal so the IR stays
    // well-formed. Unusual but observed nowhere in samples; preserved
    // here defensively.
    return {
      id: el.getAttribute("id") || "",
      value: { id: "", data: "" },
    };
  }
  return {
    id: el.getAttribute("id") || "",
    value: parseValueLiteral(valEl),
  };
}

/**
 * @param {Element} el
 * @returns {PortConstant}
 */
function parseConstant(el) {
  /** @type {PortConstant} */
  const c = { port: el.getAttribute("port") || "" };
  const structEl = childEl(el, "structure");
  if (structEl) c.value = parseTypedValue(structEl);
  return c;
}

/**
 * @param {Element} el
 * @returns {PortGroup}
 */
function parsePortGroup(el) {
  return {
    id: el.getAttribute("id") || "",
    size: Number.parseInt(el.getAttribute("size") || "0", 10),
  };
}

/**
 * @param {Element} el
 * @returns {TypedValue}
 */
function parseTypedValue(el) {
  /** @type {TypedValue} */
  const tv = { structure: el.getAttribute("id") || "" };
  if (el.hasAttribute("plugin")) tv.plugin = el.getAttribute("plugin") || "";
  const valEl = childEl(el, "value");
  if (valEl) tv.value = parseValueLiteral(valEl);
  return tv;
}

/**
 * @param {Element} el
 * @returns {ValueLiteral}
 */
function parseValueLiteral(el) {
  /** @type {ValueLiteral} */
  const v = { id: el.getAttribute("id") || "", data: "" };
  if (el.hasAttribute("plugin")) v.plugin = el.getAttribute("plugin") || "";
  const { data, cdata } = readValueText(el);
  v.data = data;
  if (cdata) v.cdata = true;
  return v;
}

/**
 * Capture text content from a <value> element. We walk childNodes
 * (rather than using `.textContent` directly) so we can detect whether
 * the source used a CDATA section — the serializer needs to know.
 *
 * @param {Element} el
 * @returns {{ data: string, cdata: boolean }}
 */
function readValueText(el) {
  let data = "";
  let cdata = false;
  for (const n of /** @type {NodeListOf<Node>} */ (el.childNodes)) {
    if (n.nodeType === 4 /* CDATA_SECTION_NODE */) {
      data += /** @type {CharacterData} */ (n).data;
      cdata = true;
    } else if (n.nodeType === 3 /* TEXT_NODE */) {
      data += /** @type {CharacterData} */ (n).data;
    }
  }
  return { data, cdata };
}

/**
 * @param {Element} el
 * @returns {Net}
 */
function parseNet(el) {
  return {
    name: el.getAttribute("name") || "",
    connections: childrenEls(el, "connection").map((c) => ({
      node: c.getAttribute("node") || "",
      port: c.getAttribute("port") || "",
    })),
  };
}

/**
 * @param {Element} el
 * @param {"filter"|"transformation"} kind
 * @returns {SubflowInstance}
 */
function parseSubflow(el, kind) {
  const innerElx = childEl(el, "elx");
  if (!innerElx) {
    throw new Error(
      `<${kind} name="${el.getAttribute("name") || ""}"> has no inner <elx> body`
    );
  }
  /** @type {SubflowInstance} */
  const sf = {
    kind,
    id: el.getAttribute("id") || "",
    name: el.getAttribute("name") || "",
    type: el.getAttribute("type") || "",
    body: parseFlow(innerElx),
  };
  if (el.hasAttribute("plugin")) sf.plugin = el.getAttribute("plugin") || "";
  return sf;
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
 * Collect any attributes / children on `el` that aren't in the known
 * sets, so they survive round-trip. Returns undefined when nothing
 * unknown was found, to keep the IR JSON tidy.
 *
 * @param {Element} el
 * @param {Set<string>} knownAttrs
 * @param {Set<string>} knownChildren
 * @returns {Extras|undefined}
 */
function collectExtras(el, knownAttrs, knownChildren) {
  /** @type {Record<string,string>} */
  const attrs = {};
  for (const a of /** @type {NamedNodeMap} */ (el.attributes)) {
    if (!knownAttrs.has(a.name)) attrs[a.name] = a.value;
  }
  /** @type {string[]} */
  const children = [];
  const serializer = new XMLSerializer();
  for (const c of /** @type {HTMLCollection} */ (el.children)) {
    if (!knownChildren.has(c.localName)) children.push(serializer.serializeToString(c));
  }
  if (Object.keys(attrs).length === 0 && children.length === 0) return undefined;
  return { attrs, children };
}
