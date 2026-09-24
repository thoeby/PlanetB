// @ts-check
// process.js — a process server's processes (TASKS-flows.md FL.3).
//
// Copied from wireon-process-editor src/api/rest.js at
// ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b (listFlows, getFlowElx, saveFlowElx,
// processExists, duplicateProcess, validateFlow and their readers); changes:
// bound to one server's address, and a new or renamed process carries its
// name as `?name=`. The reference sends ELX text alone and has nowhere to put a
// name; this is the working assumption, recorded in docs/flow.md beside the
// other unconfirmed write shapes.

import { serverClient } from "./client.js";
import { attr, childEl, childText, children, extractDocumentText } from "./envelope.js";

/**
 * @typedef {Object} ProcessRow
 * @property {string} id
 * @property {string} name
 * @property {string} [group]
 */

/** @param {Element | null} el @returns {ProcessRow} */
function toProcess(el) {
  const id = childText(el, "id") || attr(el, "id");
  return { id, name: childText(el, "name") || id, group: childText(el, "group_flat") };
}

/** @param {Element | null} data */
function readExists(data) {
  if (!data) return false;
  const t = childText(data, "exists") || attr(data, "exists");
  return t === "true" || t === "1";
}

/** @param {Element | null} data */
function validationErrors(data) {
  if (!data) return [];
  const wrap = childEl(data, "errors");
  return children(wrap ?? data, "error").map((e) => ({
    message: (childText(e, "message") || (e.children.length ? "" : e.textContent || "")
      .trim()) || "Validation error",
    node: attr(e, "node") || childText(e, "node") || undefined,
  }));
}

/** @param {string} url */
export function processApi(url) {
  const { request } = serverClient(url);
  return {
    /** @returns {Promise<ProcessRow[]>} */
    list: async () => children(await request("GET", "/process",
      { query: { limit: 200, offset: 0 } }), "process").map(toProcess),
    /** @param {string} id */
    elx: async (id) => extractDocumentText(await request("GET",
      `/process/${encodeURIComponent(id)}/download`, { query: { type: "elx" } })),
    /** @param {string} name */
    exists: async (name) => readExists(await request("GET", "/process/exists",
      { query: { name } })),
    /** @param {string} name @param {string} elx */
    create: async (name, elx) => toProcess(childEl(await request("PUT", "/process",
      { query: { name }, body: elx }), "process")),
    /** @param {string} id @param {string} elx */
    update: (id, elx) => request("PATCH", `/process/${encodeURIComponent(id)}`,
      { body: elx }),
    /** @param {string} id @param {string} name */
    rename: (id, name) => request("PATCH", `/process/${encodeURIComponent(id)}`,
      { query: { name } }),
    /** @param {string} id @param {string} newName */
    duplicate: async (id, newName) => toProcess(childEl(await request("POST",
      "/process/duplicate", { body: { id: /^\d+$/.test(id) ? Number(id) : id,
        new_name: newName } }), "process")),
    /** @param {string} id */
    remove: (id) => request("DELETE", `/process/${encodeURIComponent(id)}`),
    /** @param {string} elx */
    validate: async (elx) => validationErrors(await request("POST", "/process/validate",
      { body: elx })),
  };
}
