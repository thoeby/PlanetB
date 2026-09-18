// @ts-check
// Copied from wireon-process-editor src/elx/serialize.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none
/**
 * ELX serializer: Flow IR -> XML text.
 *
 * Strategy (per ARCHITECTURE.md):
 *   1. Build a fresh DOM from the IR using document.implementation
 *      .createDocument + Document.createElement / createCDATASection.
 *   2. Walk the DOM and emit a pretty-printed string with four-space
 *      indentation matching the server's style. We do not use
 *      XMLSerializer — its whitespace is unpredictable.
 *
 * Round-trip invariants this satisfies:
 *   - parse(serialize(parse(input)))  ≡  parse(input)     IR-stable
 *   - serialize(parse(serialize(ir))) === serialize(ir)   idempotent output
 *
 * Byte-identity with the original source is a non-goal.
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

const INDENT = "    "; // four spaces, per the server's style.

// Elements that always emit an explicit close tag, even when empty.
// Observed in samples: `<port_group ...></port_group>`. Other empty
// elements self-close.
const FORCE_EXPLICIT_CLOSE = new Set(["port_group"]);

/**
 * @param {Flow} flow
 * @returns {string}
 */
export function serializeElx(flow) {
  const doc = document.implementation.createDocument(null, "elx", null);
  buildFlow(doc, /** @type {Element} */ (doc.documentElement), flow);
  return prettyPrintElement(doc.documentElement, "") + "\n";
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element} parent       The <elx> root (or inner one for subflows)
 * @param {Flow} flow
 */
function buildFlow(doc, parent, flow) {
  parent.appendChild(buildEngine(doc, flow.engine));
  for (const i of flow.inputs) parent.appendChild(buildPseudoNode(doc, i));
  for (const o of flow.outputs) parent.appendChild(buildPseudoNode(doc, o));
  for (const n of flow.nodes) parent.appendChild(buildNodeInstance(doc, n));
  for (const sf of flow.subflows) parent.appendChild(buildSubflow(doc, sf));
  for (const net of flow.nets) parent.appendChild(buildNet(doc, net));
}

/**
 * @param {Document} doc
 * @param {EngineConfig} engine
 */
function buildEngine(doc, engine) {
  const el = doc.createElement("engine");
  el.setAttribute("type", engine.type);
  const ms = doc.createElement("max_steps");
  ms.textContent = String(engine.maxSteps);
  el.appendChild(ms);
  const rh = doc.createElement("record_history");
  rh.textContent = engine.recordHistory ? "true" : "false";
  el.appendChild(rh);
  return el;
}

/**
 * @param {Document} doc
 * @param {PseudoNode} p
 */
function buildPseudoNode(doc, p) {
  const el = doc.createElement(p.kind);
  el.setAttribute("name", p.name);
  if (p.structure) el.appendChild(buildTypedValue(doc, p.structure));
  return el;
}

/**
 * @param {Document} doc
 * @param {NodeInstance} n
 */
function buildNodeInstance(doc, n) {
  const el = doc.createElement("node");
  // Attribute order matches the server's style: id, name, plugin, then
  // any extras that survived round-trip.
  el.setAttribute("id", n.id);
  el.setAttribute("name", n.name);
  el.setAttribute("plugin", n.plugin);
  if (n.extras) {
    for (const [k, v] of Object.entries(n.extras.attrs)) el.setAttribute(k, v);
  }
  for (const p of n.parameters) el.appendChild(buildParameter(doc, p));
  for (const c of n.constants) el.appendChild(buildConstant(doc, c));
  for (const pg of n.portGroups) el.appendChild(buildPortGroup(doc, pg));
  if (n.extras) {
    for (const childXml of n.extras.children) {
      const placeholder = doc.createElement("__elx_extra__");
      placeholder.setAttribute("xml", childXml);
      el.appendChild(placeholder);
    }
  }
  return el;
}

/**
 * @param {Document} doc
 * @param {ParameterOverride} p
 */
function buildParameter(doc, p) {
  const el = doc.createElement("parameter");
  el.setAttribute("id", p.id);
  el.appendChild(buildValue(doc, p.value));
  return el;
}

/**
 * @param {Document} doc
 * @param {PortConstant} c
 */
function buildConstant(doc, c) {
  const el = doc.createElement("constant");
  el.setAttribute("port", c.port);
  if (c.value) el.appendChild(buildTypedValue(doc, c.value));
  return el;
}

/**
 * @param {Document} doc
 * @param {PortGroup} pg
 */
function buildPortGroup(doc, pg) {
  const el = doc.createElement("port_group");
  el.setAttribute("id", pg.id);
  el.setAttribute("size", String(pg.size));
  return el;
}

/**
 * @param {Document} doc
 * @param {TypedValue} tv
 */
function buildTypedValue(doc, tv) {
  const el = doc.createElement("structure");
  el.setAttribute("id", tv.structure);
  if (tv.plugin !== undefined) el.setAttribute("plugin", tv.plugin);
  if (tv.value) el.appendChild(buildValue(doc, tv.value));
  return el;
}

/**
 * @param {Document} doc
 * @param {ValueLiteral} v
 */
function buildValue(doc, v) {
  const el = doc.createElement("value");
  el.setAttribute("id", v.id);
  if (v.plugin !== undefined) el.setAttribute("plugin", v.plugin);
  if (v.cdata) {
    el.appendChild(doc.createCDATASection(v.data));
  } else if (v.data !== "") {
    el.appendChild(doc.createTextNode(v.data));
  }
  return el;
}

/**
 * @param {Document} doc
 * @param {SubflowInstance} sf
 */
function buildSubflow(doc, sf) {
  const el = doc.createElement(sf.kind);
  el.setAttribute("id", sf.id);
  el.setAttribute("name", sf.name);
  if (sf.plugin !== undefined) el.setAttribute("plugin", sf.plugin);
  el.setAttribute("type", sf.type);
  const inner = doc.createElement("elx");
  buildFlow(doc, inner, sf.body);
  el.appendChild(inner);
  return el;
}

/**
 * @param {Document} doc
 * @param {Net} net
 */
function buildNet(doc, net) {
  const el = doc.createElement("net");
  el.setAttribute("name", net.name);
  for (const c of net.connections) {
    const conn = doc.createElement("connection");
    conn.setAttribute("node", c.node);
    conn.setAttribute("port", c.port);
    el.appendChild(conn);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Pretty-printer — walks the DOM, emits indented XML.
// ---------------------------------------------------------------------------

/**
 * Render `el` at the given indent prefix. Element children get a new
 * indent level; text/CDATA children stay on the parent's line.
 *
 * @param {Element} el
 * @param {string} indent
 * @returns {string}
 */
function prettyPrintElement(el, indent) {
  // Round-trip-extras placeholder: emit the raw stored XML verbatim,
  // re-indented to match the current depth.
  if (el.tagName === "__elx_extra__") {
    const raw = el.getAttribute("xml") || "";
    return reindent(raw, indent);
  }

  const open = `<${el.tagName}${formatAttrs(el)}`;

  /** @type {Node[]} */
  const kids = [];
  for (const c of /** @type {NodeListOf<Node>} */ (el.childNodes)) kids.push(c);

  if (kids.length === 0) {
    if (FORCE_EXPLICIT_CLOSE.has(el.tagName)) {
      return indent + open + `></${el.tagName}>`;
    }
    return indent + open + "/>";
  }

  // Inline (single-line) form: only text/CDATA children, no elements.
  const allTextOrCData = kids.every(
    (n) => n.nodeType === 3 /* TEXT */ || n.nodeType === 4 /* CDATA */
  );
  if (allTextOrCData) {
    const inner = emitTextChildren(kids);
    return indent + open + ">" + inner + `</${el.tagName}>`;
  }

  // Block (multi-line) form: at least one element child.
  let out = indent + open + ">";
  const childIndent = indent + INDENT;
  for (const k of kids) {
    if (k.nodeType === 1 /* ELEMENT */) {
      out += "\n" + prettyPrintElement(/** @type {Element} */ (k), childIndent);
    } else if (k.nodeType === 4 /* CDATA */) {
      out += "\n" + childIndent + "<![CDATA[" + /** @type {CharacterData} */ (k).data + "]]>";
    }
    // Plain whitespace text nodes between elements (which shouldn't
    // exist in our build, but just in case) are skipped.
  }
  out += "\n" + indent + `</${el.tagName}>`;
  return out;
}

/**
 * Emit text/CDATA children on a single line. CDATA is preserved
 * verbatim; plain text is XML-escaped.
 *
 * @param {Node[]} kids
 */
function emitTextChildren(kids) {
  let out = "";
  for (const k of kids) {
    if (k.nodeType === 3) {
      out += escapeText(/** @type {CharacterData} */ (k).data);
    } else if (k.nodeType === 4) {
      out += "<![CDATA[" + /** @type {CharacterData} */ (k).data + "]]>";
    }
  }
  return out;
}

/**
 * Format `el`'s attributes in source order. Attribute order is
 * controlled by the order in which we called setAttribute() during
 * DOM construction.
 *
 * @param {Element} el
 */
function formatAttrs(el) {
  let s = "";
  for (const a of /** @type {NamedNodeMap} */ (el.attributes)) {
    s += ` ${a.name}="${escapeAttr(a.value)}"`;
  }
  return s;
}

/**
 * Reindent a multi-line XML string to start at `indent`. Used for the
 * extras-children round-trip: the stored XML came from XMLSerializer
 * which is whitespace-uneven, so we don't try to re-pretty it — we just
 * shift it as a single unit and let the developer fix formatting if
 * extras ever start appearing in real samples.
 *
 * @param {string} xml
 * @param {string} indent
 */
function reindent(xml, indent) {
  return indent + xml;
}

/**
 * @param {string} s
 */
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {string} s
 */
function escapeAttr(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
