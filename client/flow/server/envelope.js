// @ts-check
// Copied from wireon-process-editor src/api/rest.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// ApiError and parseEnvelope, with the DOM helpers the readers need, copied
// from src/api/xml.js at the same commit (children, attr, extractDocumentText
// added for TASKS-flows.md FL.1–FL.5; was client/flow/validate.js until FL.1).
/**
 * The `<elx_api_msg>` envelope every process server answers in.
 *
 * The server speaks no JSON: a validate is a POST of the ELX text and the
 * answer is this envelope, with `<error><code>0</code></error>` for "yes" and
 * a code and a message for "no". Pure — it knows nothing about fetch, so the
 * page's own request code (client/js/flowcheck.js) stays ours.
 */

/**
 * The first direct child element of `el` whose tag is `name`, or `null`.
 *
 * @param {Element | null | undefined} el
 * @param {string} name
 * @returns {Element | null}
 */
export function childEl(el, name) {
  if (!el) return null;
  for (const c of /** @type {HTMLCollection} */ (el.children)) {
    if (c.localName === name) return c;
  }
  return null;
}

/**
 * Trimmed text of the first direct `<name>` child, or `""` when absent.
 *
 * @param {Element | null | undefined} el
 * @param {string} name
 * @returns {string}
 */
export function childText(el, name) {
  const c = childEl(el, name);
  return c ? (c.textContent || "").trim() : "";
}

export class ApiError extends Error {
  /**
   * @param {number} status     HTTP status, or the app error code for
   *   envelope errors / 0 for parse failures.
   * @param {string} body       Raw HTTP body or the descriptive message.
   * @param {number} [errorCode]  Envelope `<error><code>`, when applicable.
   */
  constructor(status, body, errorCode) {
    super(
      errorCode != null
        ? `API error ${errorCode}: ${body}`
        : status
          ? `HTTP ${status}: ${body}`
          : String(body)
    );
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (errorCode != null) this.errorCode = errorCode;
  }
}

/**
 * Parse the `<elx_api_msg>` envelope that wraps every server response.
 *
 * @param {string} text   Raw XML response body.
 * @returns {Element | null}  The `<data>` Element, or `null` when `<data>`
 *   is absent / self-closed / has no element children.
 * @throws {ApiError}  Malformed XML, a non-`<elx_api_msg>` root, or a
 *   non-zero `<error><code>` (an application error).
 */
export function parseEnvelope(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const perr = doc.getElementsByTagName("parsererror")[0];
  if (perr) {
    throw new ApiError(0, "Malformed XML envelope: " + (perr.textContent || "").trim());
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "elx_api_msg") {
    const found = root ? root.localName : "(empty document)";
    throw new ApiError(0, `Unexpected envelope root <${found}>, expected <elx_api_msg>`);
  }
  const errEl = childEl(root, "error");
  const codeText = errEl ? childText(errEl, "code") : "";
  const code = codeText ? Number(codeText) : 0;
  if (code !== 0) {
    const msg = errEl ? childText(errEl, "message") : "";
    throw new ApiError(code, msg || `error code ${code}`, code);
  }
  const dataEl = childEl(root, "data");
  if (!dataEl || dataEl.children.length === 0) return null;
  return dataEl;
}

/**
 * Every direct child element of `el` whose tag is `name`.
 *
 * @param {Element | null | undefined} el
 * @param {string} name
 * @returns {Element[]}
 */
export function children(el, name) {
  if (!el) return [];
  return [...el.children].filter((c) => c.localName === name);
}

/**
 * The first non-empty attribute of `el` among `names`, or `""`.
 *
 * @param {Element | null | undefined} el
 * @param {...string} names
 * @returns {string}
 */
export function attr(el, ...names) {
  if (!el) return "";
  for (const n of names) {
    const v = el.getAttribute(n);
    if (v != null && v !== "") return v;
  }
  return "";
}

/**
 * The document a read carries: `<document><content>` holds it entity-encoded
 * (textContent decodes it); a payload sitting directly under `<data>` is
 * serialized back as it is.
 *
 * @param {Element | null} dataEl
 * @returns {string}
 */
export function extractDocumentText(dataEl) {
  if (!dataEl) return "";
  const content = childEl(childEl(dataEl, "document"), "content");
  if (content) return content.textContent || "";
  const first = dataEl.firstElementChild;
  return first ? new XMLSerializer().serializeToString(first) : "";
}
