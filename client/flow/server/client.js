// @ts-check
// client.js — talking to one process server (TASKS-flows.md FL.1).
//
// The request half of wireon-process-editor src/api/rest.js and the route
// prefix of src/api/endpoints.js, at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b,
// cut down to what this page asks. Every answer is the `<elx_api_msg>`
// envelope (envelope.js); a non-zero code with HTTP 200 is a refusal, and its
// message is what the page shows.
//
// Invariant 9: this runs in the player's tab. The world never calls a process
// server; the player's page does, from the player's own machine.

import { parseEnvelope, ApiError, childText } from "./envelope.js";

export const PREFIX = "/api/v1";

/**
 * @param {Record<string, string | number | boolean | undefined | null>} params
 * @returns {string}
 */
export function qs(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * @typedef {Object} RequestOptions
 * @property {Record<string, any>} [query]
 * @property {any} [body]        A string is sent as it is; anything else as JSON.
 * @property {string} [type]     Content-Type of a string body.
 */

/**
 * A client bound to one server's address.
 *
 * @param {string} base  e.g. "http://127.0.0.1:8091"
 */
export function serverClient(base) {
  const root = base.replace(/\/+$/, "");
  /**
   * @param {string} method
   * @param {string} path   without the prefix, e.g. "/process"
   * @param {RequestOptions} [opts]
   * @returns {Promise<Element | null>}  the envelope's `<data>`
   */
  async function request(method, path, opts = {}) {
    const init = { method, headers: /** @type {Record<string, string>} */ ({
      Accept: "application/xml" }) };
    if (opts.body !== undefined) {
      const text = typeof opts.body === "string";
      init.headers["Content-Type"] = text ? opts.type ?? "application/xml"
        : "application/json";
      /** @type {any} */ (init).body = text ? opts.body : JSON.stringify(opts.body);
    }
    const res = await fetch(root + PREFIX + path + qs(opts.query), init);
    const said = await res.text();
    if (!res.ok && !said.includes("elx_api_msg")) throw new ApiError(res.status, said);
    return parseEnvelope(said);
  }
  return { base: root, request };
}

/**
 * @typedef {Object} Reach
 * @property {"up" | "down" | "cors"} state
 * @property {string} [version]
 */

/**
 * Whether a server answers, and — when the page cannot read it — whether it
 * answered at all. A fetch the browser blocks for CORS and a fetch nobody
 * answered throw the same error; an opaque (no-cors) request tells them apart.
 *
 * @param {string} url
 * @returns {Promise<Reach>}
 */
export async function reach(url) {
  const probe = `${url.replace(/\/+$/, "")}${PREFIX}/system/status`;
  try {
    const res = await fetch(probe, { headers: { Accept: "application/xml" } });
    const data = parseEnvelope(await res.text());
    return { state: "up", version: childText(data, "version") };
  } catch {
    try {
      await fetch(probe, { mode: "no-cors" });
      return { state: "cors" };
    } catch {
      return { state: "down" };
    }
  }
}

/**
 * What the page says about a reach, in the dialog's words
 * (docs/design/flows-servers.md §1a).
 *
 * @param {Reach} r
 * @param {string} origin
 * @returns {string}
 */
export function reachWords(r, origin) {
  if (r.state === "up") return `Answered${r.version ? ` — elx ${r.version}` : ""}.`;
  if (r.state === "cors") {
    return "It answered, but this page is not allowed to read it (CORS) — "
      + `the server has to allow ${origin}.`;
  }
  return "That address did not answer.";
}

/**
 * Any failure of a request, as the sentence the page shows.
 *
 * @param {unknown} err
 * @param {string} name   the server's name as the player gave it
 * @returns {string}
 */
export function failWords(err, name) {
  if (err instanceof ApiError && err.errorCode != null) {
    return `${name} said: ${err.body || err.message}`;
  }
  if (err instanceof ApiError && err.status) return `${name} said: HTTP ${err.status}`;
  return `${name} did not answer.`;
}
