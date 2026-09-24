// @ts-check
// records.js — a process server's services, jobs and reports (TASKS-flows.md
// FL.4, FL.5).
//
// Copied from wireon-process-editor src/api/rest.js at
// ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b (listServices … deleteReport, and
// toServiceDescriptor, toJobDescriptor, toJobTrigger, toJobPayload,
// toTriggerPayload, toReportSummary); changes: bound to one server's address,
// split from the process half, and trimmed of what this page does not show.
// Write bodies are JSON, as the reference sends them — whether the server
// wants XML there is open (docs/flow.md), and a refusal is shown in its words.

import { serverClient } from "./client.js";
import { attr, childEl, childText, children, extractDocumentText } from "./envelope.js";

/** The loose `<name>` children of `el`, serialized back into `<wrap>…</wrap>`. */
function rewrap(el, name, wrap) {
  const s = new XMLSerializer();
  return `<${wrap}>${children(el, name).map((c) => s.serializeToString(c)).join("")}</${wrap}>`;
}

/** @param {Element | null} el */
function toService(el) {
  return {
    id: attr(el, "id") || childText(el, "id"),
    name: childText(el, "name"),
    pluginId: attr(el, "plugin", "plugin_id"),
    componentId: attr(el, "component-id", "component_id"),
    parameters: el ? rewrap(el, "parameter", "parameters") : "<parameters></parameters>",
  };
}

/** @param {Element} el */
function toTrigger(el) {
  /** @param {string} n */
  const opt = (n) => childText(el, n) || undefined;
  const on = childText(el, "enabled");
  return {
    type: attr(el, "type"), enabled: on === "" ? undefined : on === "true",
    expression: opt("expression"), method: opt("method"), target: opt("target"),
    inputNameRequest: opt("input_name_request"),
    inputNameCaptures: opt("input_name_captures"),
    outputNameResponse: opt("output_name_response"), serviceId: opt("service_id"),
    path: opt("path"), recursive: childText(el, "recursive") === "true",
    inputNameAction: opt("input_name_action"), topic: opt("topic"),
    inputNameTopic: opt("input_name_topic"), inputNamePayload: opt("input_name_payload"),
  };
}

/** @param {Element | null} el */
function toJob(el) {
  const config = childEl(el, "config");
  return {
    id: attr(el, "id") || childText(el, "id"),
    name: childText(el, "name"),
    group: childText(el, "group_flat"),
    processId: attr(childEl(el, "process"), "id") || childText(el, "process_id"),
    processName: childText(el, "process_name"),
    logLevel: childText(config, "log_level") || "info",
    storeReport: childText(config, "store_report") || "always",
    inputs: el ? rewrap(el, "input", "inputs") : "<inputs></inputs>",
    triggers: children(el, "trigger").map(toTrigger),
  };
}

/** @param {string} t */
const num = (t) => (t !== "" && Number.isFinite(Number(t)) ? Number(t) : undefined);

/** @param {Element} el */
function toReport(el) {
  const raw = childText(el, "result_code") || childText(el, "code") || attr(el, "result_code");
  const code = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  return {
    id: attr(el, "id") || childText(el, "id"),
    jobId: attr(el, "job_id") || childText(el, "job_id"),
    jobName: childText(el, "job_name"),
    timestamp: childText(el, "timestamp") || childText(el, "created_at"),
    code, ok: code === undefined ? undefined : code === 0,
    // The Planner's (planner.js): how long the run took, what started it,
    // and how many warnings it logged. Assumed names, like the rest of the
    // report row (docs/flow.md); absent, the Planner draws a tick and says "—".
    duration: num(childText(el, "duration_ms") || attr(el, "duration_ms")),
    startedBy: childText(el, "started_by") || undefined,
    warnings: num(childText(el, "warnings")) ?? 0,
    running: childText(el, "state") === "running",
  };
}

const TRIGGER_FIELDS = {
  cron: ["expression"],
  http: ["method", "target", "input_name_request", "input_name_captures",
    "output_name_response", "service_id"],
  filesystem: ["path", "recursive", "input_name_action"],
  mqtt: ["service_id", "topic", "input_name_topic", "input_name_payload"],
};
/** @param {string} snake */
const camel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** @param {any} t */
function triggerPayload(t) {
  /** @type {Record<string, any>} */
  const out = { type: t.type, enabled: t.enabled !== false };
  for (const f of TRIGGER_FIELDS[/** @type {keyof TRIGGER_FIELDS} */ (t.type)] ?? []) {
    const v = t[camel(f)];
    out[f] = f === "recursive" ? Boolean(v) : v ?? "";
  }
  return out;
}

/** @param {any} job */
const jobPayload = (job) => ({
  group_flat: job.group ?? "", name: job.name,
  process_id: /^\d+$/.test(job.processId) ? Number(job.processId) : job.processId,
  inputs: job.inputs, cfg_log_level: job.logLevel, cfg_store_report: job.storeReport,
  triggers: (job.triggers ?? []).map(triggerPayload),
});

/** @param {any} svc */
const servicePayload = (svc) => ({ name: svc.name, plugin_id: svc.pluginId,
  component_id: svc.componentId, parameters: svc.parameters });

/** @param {string} url */
export function recordsApi(url) {
  const { request } = serverClient(url);
  const page = { limit: 200, offset: 0 };
  /** @param {string | number} id */
  const at = (id) => encodeURIComponent(String(id));
  return {
    services: async () => children(await request("GET", "/service", { query: page }),
      "service").map(toService),
    /** @param {string} name */
    serviceExists: async (name) => ["true", "1"].includes(childText(
      await request("GET", "/service/exists", { query: { name } }), "exists")),
    /** @param {any} svc */
    createService: async (svc) => toService(childEl(await request("POST", "/service",
      { body: servicePayload(svc) }), "service")),
    /** @param {string} id @param {any} svc */
    updateService: (id, svc) => request("PATCH", `/service/${at(id)}`,
      { body: servicePayload(svc) }),
    /** @param {string} id */
    deleteService: (id) => request("DELETE", `/service/${at(id)}`),

    jobs: async () => children(await request("GET", "/job", { query: page }), "job")
      .map(toJob),
    /** @param {any} job */
    createJob: async (job) => toJob(childEl(await request("POST", "/job",
      { body: jobPayload(job) }), "job")),
    /** @param {string} id @param {any} job */
    updateJob: (id, job) => request("PATCH", `/job/${at(id)}`, { body: jobPayload(job) }),
    /** @param {string} id */
    deleteJob: (id) => request("DELETE", `/job/${at(id)}`),
    /** @param {string} id */
    runJob: async (id) => {
      const data = await request("POST", `/job/${at(id)}/run`);
      const rep = childEl(data, "report");
      return rep ? toReport(rep) : null;
    },

    /** @param {string} [jobId] */
    reports: async (jobId) => children(await request("GET", "/report",
      { query: { job_id: jobId, ...page } }), "report").map(toReport),
    /** @param {string} id */
    reportXml: async (id) => extractDocumentText(await request("GET", `/report/${at(id)}`)),
    /** @param {string} id */
    deleteReport: (id) => request("DELETE", "/report", { query: { id } }),
  };
}
