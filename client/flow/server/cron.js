// @ts-check
// Copied from wireon-process-editor src/jobs/cron.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes:
// none (TASKS-flows.md FL.5). The server is the authority on when a job runs.
/**
 * Minimal cron evaluator for the Jobs panel (Phase 20.3).
 *
 * Supports the standard 5-field cron syntax — `minute hour day-of-month
 * month day-of-week` — with `*`, lists (`a,b`), ranges (`a-b`), and steps
 * (`* /n`, `a-b/n`, `a/n`). Day-of-week is `0-6` (0 = Sunday). When both
 * day-of-month and day-of-week are restricted, a row matches if *either*
 * field matches (standard Vixie-cron OR semantics).
 *
 * Used only to render the "next 5 firings" preview client-side; the server
 * is the authority on actual scheduling. Pure (no DOM), so it runs under a
 * Node test harness as well as in the browser.
 */

/**
 * @typedef {Object} CronSpec
 * @property {Set<number>} minute
 * @property {Set<number>} hour
 * @property {Set<number>} dom
 * @property {Set<number>} month
 * @property {Set<number>} dow
 * @property {boolean} domRestricted
 * @property {boolean} dowRestricted
 */

/**
 * Parse a 5-field cron expression. Throws on malformed input.
 *
 * @param {string} expr
 * @returns {CronSpec}
 */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must have 5 fields (min hour dom month dow)");
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/**
 * Expand one cron field into the set of allowed values.
 *
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {Set<number>}
 */
function parseField(field, min, max) {
  /** @type {Set<number>} */
  const allowed = new Set();
  for (const piece of field.split(",")) {
    let step = 1;
    let range = piece;
    const slash = piece.indexOf("/");
    if (slash >= 0) {
      step = parseInt(piece.slice(slash + 1), 10);
      range = piece.slice(0, slash);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error("bad step in cron field: " + piece);
      }
    }
    let lo, hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.indexOf("-") >= 0) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(range, 10);
      // A bare value with a step (e.g. "5/15") runs from the value up to max.
      hi = slash >= 0 ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error("bad range in cron field: " + piece);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

/**
 * Compute the next `count` firing times for a cron expression, starting
 * strictly after `from`. Returns fewer than `count` only if a (very high)
 * iteration guard trips, which shouldn't happen for valid expressions.
 *
 * The loop skips coarsely — whole months/days/hours when those fields
 * don't match — so it stays cheap even for sparse schedules like
 * "0 0 29 2 *" (Feb 29).
 *
 * @param {string} expr
 * @param {Date} [from]
 * @param {number} [count]
 * @returns {Date[]}
 */
export function cronNextFirings(expr, from = new Date(), count = 5) {
  const c = parseCron(expr);
  /** @type {Date[]} */
  const results = [];

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`

  const MAX_ITERS = 500000;
  let guard = 0;
  while (results.length < count && guard++ < MAX_ITERS) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    results.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return results;
}

/**
 * Day match honoring Vixie-cron's OR semantics: when both day fields are
 * restricted, either matching is enough; otherwise only the restricted one
 * (if any) applies.
 *
 * @param {CronSpec} c
 * @param {Date} d
 * @returns {boolean}
 */
function dayMatches(c, d) {
  const dom = d.getDate();
  const dow = d.getDay(); // 0 = Sunday
  if (c.domRestricted && c.dowRestricted) return c.dom.has(dom) || c.dow.has(dow);
  if (c.domRestricted) return c.dom.has(dom);
  if (c.dowRestricted) return c.dow.has(dow);
  return true;
}
